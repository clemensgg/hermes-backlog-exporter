const { exec } = require('child_process');
const axios = require('axios');
const moment = require('moment');
const client = require('prom-client');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const fs = require('fs');

const config = require('./config.json');

const register = new client.Registry();

const app = express();
const db = new sqlite3.Database(config.dbPath);

fs.unlink(config.dbPath, (err) => {
  if (err) {
    console.error("An error occurred:", err);
  }
  console.log('Database file deleted successfully.');

  const db = new sqlite3.Database(config.dbPath);

  db.run('CREATE TABLE IF NOT EXISTS pending_packets (sequence INTEGER, timestamp TEXT, src_chain TEXT, src_channel TEXT, src_port TEXT, dst_chain TEXT, packet_type TEXT)', (err) => {
    if (err) {
      console.error("Error while creating database:", err.message);
      return;
    }
    console.log("Database created successfully");
  });
});

const packetPendingGauge = new client.Gauge({
  name: 'packet_pending',
  help: 'Pending packets on a channel',
  labelNames: ['src_chain', 'src_channel', 'src_port', 'dst_chain', 'packet_type']
});
register.registerMetric(packetPendingGauge);

const sequencePendingGauge = new client.Gauge({
  name: 'sequence_pending',
  help: 'Pending status of a sequence',
  labelNames: ['sequence', 'src_chain', 'src_channel', 'src_port', 'dst_chain', 'packet_type']
});
register.registerMetric(sequencePendingGauge);

const oldestSequenceTimestampGauge = new client.Gauge({
  name: 'timestamp_oldest_pending_sequence',
  help: 'Timestamp of oldest pending sequence',
  labelNames: ['src_chain', 'src_channel', 'src_port', 'dst_chain', 'packet_type']
});
register.registerMetric(oldestSequenceTimestampGauge);


app.get('/metrics', async (req, res) => {
  try {
    console.log("Handling request for /metrics");
    const metrics = await register.metrics();
    res.set('Content-Type', register.contentType);
    res.end(metrics);
  } catch (err) {
    console.error("Error while generating metrics:", err);
    res.status(500).end(err);
  }
});

app.listen(config.port, () => console.log('Server listening on port ' + config.port));

async function main() {
  try {
    const configFilePath = config.configFilePath;
    const api = config.api;

    const runTask = async () => {
      const stateData = (await axios.get(`${api}/state`)).data;
      if (!stateData) {
        console.log(`Error: No response from ${api}`);
        process.exit(1);
      }

      const packetData = stateData.result.workers.Packet;
      const chains = Object.values(packetData).reduce((chains, packet) => {
        const chain = chains.find(c => c.chain_id === packet.object.src_chain_id);
        if (!chain) {
          chains.push({
            chain_id: packet.object.src_chain_id,
            channels: [{
              channel_id: packet.object.src_channel_id,
              port_id: packet.object.src_port_id,
              dst_chain_id: packet.object.dst_chain_id
            }]
          });
        } else {
          chain.channels.push({
            channel_id: packet.object.src_channel_id,
            port_id: packet.object.src_port_id,
            dst_chain_id: packet.object.dst_chain_id
          });
        }
        return chains;
      }, []);

      console.log("Found chains:", JSON.stringify(chains));

      for (const chain of chains) {
        for (const channel of chain.channels) {
          const hermesCommand = `hermes --json --config ${configFilePath} query packet pending --chain ${chain.chain_id} --port ${channel.port_id} --channel ${channel.channel_id}`;
          const { exec } = require('child_process');

          const result = await new Promise((resolve, reject) => {
            exec(hermesCommand, (err, stdout) => {
              if (err) {
                reject(err);
              } else {
                const resultLine = stdout.match(/{"result":{[\s\S]*?},"status":"success"}/);

                try {
                  const jsonOutput = JSON.parse(resultLine[0]);
                  console.log('jsonOutput:', JSON.stringify(jsonOutput));
                  resolve(jsonOutput);
                } catch (error) {
                  reject(error);
                }
              }
            });
          });

          let packetSequences = [];
          let ackSequences = [];

          if (result && result.status === 'success') {
            const { dst, src } = result.result;

            const unreceivedPackets = dst.unreceived_packets.concat(src.unreceived_packets);
            const unreceivedAcks = dst.unreceived_acks.concat(src.unreceived_acks);

            for (const packet of unreceivedPackets) {
              packetSequences.push({ sequence: packet, packet_type: 'packet' });
            }

            for (const ack of unreceivedAcks) {
              ackSequences.push({ sequence: ack, packet_type: 'ack' });
            }
          } else {
            console.log('Error: Could not extract pending packets');
          }

          // Fetch sequences from database, including the packet_type
          db.all(`SELECT sequence, packet_type FROM pending_packets WHERE src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ?`,
            [chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err, rows) => {
              if (err) {
                console.error("Database select error:", err);
                throw err;
              }

              const existingSequences = rows.map(row => ({ sequence: row.sequence, packet_type: row.packet_type }));

              // Add new packet sequences
              for (const packetObj of packetSequences) {
                if (!existingSequences.find(existSeq => existSeq.sequence === packetObj.sequence && existSeq.packet_type === packetObj.packet_type)) {
                  db.run(`INSERT INTO pending_packets (sequence, timestamp, src_chain, src_channel, src_port, dst_chain, packet_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [packetObj.sequence, moment().format('YYYY-MM-DD HH:mm:ss'), chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, packetObj.packet_type], (err) => {
                      if (err) {
                        console.error("Database insert error:", err);
                        throw err;
                      }
                      sequencePendingGauge.labels(packetObj.sequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, packetObj.packet_type).set(1);
                      packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, packetObj.packet_type).inc();
                      console.log("Increased gauge for sequence:", packetObj.sequence);

                      // Update timestamp gauge for oldest sequence
                      db.get('SELECT MIN(timestamp) as oldestTimestamp FROM pending_packets', (err, row) => {
                        if (err) {
                          console.error("Database select error:", err);
                          throw err;
                        }
                        oldestSequenceTimestampGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, packetObj.packet_type).set(new Date(row.oldestTimestamp).getTime());
                      });
                    });
                }
              }

              // Add new ack sequences
              for (const ackObj of ackSequences) {
                if (!existingSequences.find(existSeq => existSeq.sequence === ackObj.sequence && existSeq.packet_type === ackObj.packet_type)) {
                  db.run(`INSERT INTO pending_packets (sequence, timestamp, src_chain, src_channel, src_port, dst_chain, packet_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [ackObj.sequence, moment().format('YYYY-MM-DD HH:mm:ss'), chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, ackObj.packet_type], (err) => {
                      if (err) {
                        console.error("Database insert error:", err);
                        throw err;
                      }
                      sequencePendingGauge.labels(ackObj.sequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, ackObj.packet_type).set(1);
                      packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, ackObj.packet_type).inc();
                      console.log("Increased gauge for sequence:", ackObj.sequence);

                      // Update timestamp gauge for oldest sequence
                      db.get('SELECT MIN(timestamp) as oldestTimestamp FROM pending_packets', (err, row) => {
                        if (err) {
                          console.error("Database select error:", err);
                          throw err;
                        }
                        oldestSequenceTimestampGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, ackObj.packet_type).set(new Date(row.oldestTimestamp).getTime());
                      });
                    });
                }
              }

              // Remove handled packet sequences and decrease gauge
              for (const existingPacket of existingSequences.filter(seq => seq.packet_type === 'packet')) {
                if (!packetSequences.find(seq => seq.sequence === existingPacket.sequence && seq.packet_type === existingPacket.packet_type)) {
                  db.run(`DELETE FROM pending_packets WHERE sequence = ? AND src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ? AND packet_type = ?`,
                    [existingPacket.sequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingPacket.packet_type], (err) => {
                      if (err) {
                        console.error("Database delete error:", err);
                        throw err;
                      }
                      sequencePendingGauge.remove(existingPacket.sequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingPacket.packet_type);
                      packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingPacket.packet_type).dec();
                      console.log("Decreased gauge for sequence:", existingPacket.sequence);

                      // Update timestamp gauge for oldest sequence
                      db.get('SELECT MIN(timestamp) as oldestTimestamp FROM pending_packets WHERE src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ? AND packet_type = ?',
                        [chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingPacket.packet_type], (err, row) => {
                          if (err) {
                            console.error("Database select error:", err);
                            throw err;
                          }
                          if (row.oldestTimestamp) {
                            oldestSequenceTimestampGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingPacket.packet_type).set(new Date(row.oldestTimestamp).getTime());
                          } else {
                            oldestSequenceTimestampGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingPacket.packet_type).set(0);
                          }
                        });
                    });
                }
              }

              // Remove handled ack sequences and decrease gauge
              for (const existingAck of existingSequences.filter(seq => seq.packet_type === 'ack')) {
                if (!ackSequences.find(seq => seq.sequence === existingAck.sequence && seq.packet_type === existingAck.packet_type)) {
                  db.run(`DELETE FROM pending_packets WHERE sequence = ? AND src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ? AND packet_type = ?`,
                    [existingAck.sequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingAck.packet_type], (err) => {
                      if (err) {
                        console.error("Database delete error:", err);
                        throw err;
                      }
                      sequencePendingGauge.remove(existingAck.sequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingAck.packet_type);
                      packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingAck.packet_type).dec();
                      console.log("Decreased gauge for sequence:", existingAck.sequence);

                      // Update timestamp gauge for oldest sequence
                      db.get('SELECT MIN(timestamp) as oldestTimestamp FROM pending_packets WHERE src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ? AND packet_type = ?',
                        [chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingAck.packet_type], (err, row) => {
                          if (err) {
                            console.error("Database select error:", err);
                            throw err;
                          }
                          if (row.oldestTimestamp) {
                            oldestSequenceTimestampGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingAck.packet_type).set(new Date(row.oldestTimestamp).getTime());
                          } else {
                            oldestSequenceTimestampGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id, existingAck.packet_type).set(0);
                          }
                        });
                    });
                }
              }
            });
        }
      }
    };

    // Run the task immediately
    await runTask();

    // Run the task every 10 seconds
    setInterval(runTask, 10000);

  } catch (error) {
    console.error("Error in main function:", error);
    process.exit(1);
  }
}

main();
