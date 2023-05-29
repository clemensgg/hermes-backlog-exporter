const cmd = require('node-cmd');
const axios = require('axios');
const moment = require('moment');
const client = require('prom-client');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const config = require('./config.json');

const app = express();
const db = new sqlite3.Database('./hernes_backlog.db');
const packetPendingGauge = new client.Gauge({
  name: 'packet_pending',
  help: 'Pending packets on a channel',
  labelNames: ['src_chain', 'src_channel', 'src_port', 'dst_chain']
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(client.register.metrics());
});

app.listen(3000, () => console.log('Server listening on port 3000'));

db.run('CREATE TABLE IF NOT EXISTS pending_packets (sequence INTEGER, timestamp TEXT, src_chain TEXT, src_channel TEXT, src_port TEXT, dst_chain TEXT)', (err) => {
  if (err) {
    return console.error(err.message);
  }
});

async function main() {
  try {
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

    console.log(chains);

    setInterval(async () => {
      for (const chain of chains) {
        for (const channel of chain.channels) {
          const hermesCommand = `hermes --config ${configFilePath} query packet pending --chain ${chain.chain_id} --port ${channel.port_id} --channel ${channel.channel_id}`;
          const result = await new Promise((resolve, reject) => {
            cmd.get(hermesCommand, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });

          const pendingSrcMatches = result.match(/src: PendingPackets[\s\S]*?(?=dst:)/g);
          if (!pendingSrcMatches || pendingSrcMatches.length !== 1) {
            console.log("error: could not extract pending src packets");
            continue;
          }

          const unreceivedPacketsMatches = pendingSrcMatches[0].match(/unreceived_packets: \[([\s\S]*?)\],/g);
          if (!unreceivedPacketsMatches || unreceivedPacketsMatches.length !== 1) {
            console.log("error: could not extract unreceived packets");
            continue;
          }

          const sequences = unreceivedPacketsMatches[0].match(/Sequence\((\d+)\)/g).map(m => Number(m.replace('Sequence(', '').replace(')', '')));

          db.all(`SELECT sequence FROM pending_packets WHERE src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ?`, [chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err, rows) => {
            if (err) {
              throw err;
            }

            const existingSequences = rows.map(row => row.sequence);

            // add new sequences
            for (const sequence of sequences) {
              if (!existingSequences.includes(sequence)) {
                db.run(`INSERT INTO pending_packets (sequence, timestamp, src_chain, src_channel, src_port, dst_chain) VALUES (?, ?, ?, ?, ?, ?)`,
                [sequence, moment().format('YYYY-MM-DD HH:mm:ss'), chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err) => {
                  if (err) {
                    throw err;
                  }
                });
              }
            }

            // remove handled sequences and decrease gauge
            for (const existingSequence of existingSequences) {
              if (!sequences.includes(existingSequence)) {
                db.run(`DELETE FROM pending_packets WHERE sequence = ? AND src_chain = ? AND src_channel = ? AND src_port = ? AND dst_chain = ?`,
                [existingSequence, chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id], (err) => {
                  if (err) {
                    throw err;
                  }
                  packetPendingGauge.labels(chain.chain_id, channel.channel_id, channel.port_id, channel.dst_chain_id).dec();
                });
              }
            }
          });
        }
      }
    }, 60000);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();
