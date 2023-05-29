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

fs.unlink(path, (err) => {
  if (err) {
      console.error("An error occurred:", err);
  }
  console.log('Database file deleted successfully.');

  const db = new sqlite3.Database(path);

  db.run('CREATE TABLE IF NOT EXISTS pending_packets (sequence INTEGER, timestamp TEXT, src_chain TEXT, src_channel TEXT, src_port TEXT, dst_chain TEXT)', (err) => {
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
  labelNames: ['src_chain', 'src_channel', 'src_port', 'dst_chain']
});
register.registerMetric(packetPendingGauge);
packetPendingGauge.set(0);

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
    console.log("Starting main function");
    const configFilePath = config.configFilePath;
    const api = config.api;
  
    const stateData = (await axios.get(`${api}/state`)).data;
    if (!stateData) {
      console.log(`error: no response from ${api}`);
      process.exit(1);
    }

    const packetData = stateData.result.workers.Packet;
    const chains = Object.values(packetData)
      .reduce((chains, packet) => {
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
    
    const runTask = async () => {
      console.log("Running task");
      for (const chain of chains) {
        for (const channel of chain.channels) {
          console.log(`Processing chain: ${chain.chain_id}, channel: ${channel.channel_id}`);
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
                  resolve(jsonOutput);
                } catch (error) {
                  reject(error);
                }
              }
            });
          });

          let sequences = [];
          if (result && result.status === 'success') {
            const { dst, src } = result.result;

            const unreceivedPackets = dst.unreceived_packets.concat(src.unreceived_packets);
            const unreceivedAcks = dst.unreceived_acks.concat(src.unreceived_acks);

            for (const packet of unreceivedPackets) {
              sequences.push(packet);
            }

            for (const ack of unreceivedAcks) {
              sequences.push(ack);
            }

          } else {
            console.log('Error: Could not extract pending packets');
          }


          db.all(`SELECT sequence FROM pending_packets WHERE src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ?`, [chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err, rows) => {
            if (err) {
              console.error("Database select error:", err);
              throw err;
            }

            const existingSequences = rows.map(row => row.sequence);
            console.log("Existing sequences:", existingSequences);

            // add new sequences
            for (const sequence of sequences) {
              if (!existingSequences.includes(sequence)) {
                db.run(`INSERT INTO pending_packets (sequence, timestamp, src_chain, src_channel, src_port, dst_chain) VALUES (?, ?, ?, ?, ?, ?)`,
                [sequence, moment().format('YYYY-MM-DD HH:mm:ss'), chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err) => {
                  if (err) {
                    console.error("Database insert error:", err);
                    throw err;
                  }
                  packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id).inc();
                  console.log("Inserted gauge for sequence:", sequence);
                });
              }
            }

            // remove handled sequences and decrease gauge
            for (const existingSequence of existingSequences) {
              if (!sequences.includes(existingSequence)) {
                db.run(`DELETE FROM pending_packets WHERE sequence = ? AND src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ?`,
                [existingSequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err) => {
                  if (err) {
                    console.error("Database delete error:", err);
                    throw err;
                  }
                  packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id).dec();
                  console.log("Decreased gauge for sequence:", existingSequence);
                });
              }
            }
          });
        }
      }
    };

    // Run the task immediately
    await runTask();

    // Run the task every minute
    setInterval(runTask, 60000);
 
  } catch (error) {
    console.error("Error in main function:", error);
    process.exit(1);
  }
}

main();
