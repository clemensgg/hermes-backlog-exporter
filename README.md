# Hermes Packet Monitoring

This is a pretty dirty solution to visualize pending IBC packets using a [hermes](https://github.com/informalsystems/hermes) IBC relayer.

### Prerequisites

- Node.js (version 14 or above is recommended)
- npm
- [Hermes](https://github.com/informalsystems/hermes) IBC relayer by [Informal Systems](https://github.com/informalsystems)

### Installing

Clone this repository, install dependencies:

```bash
git clone https://github.com/clemensgg/hermes-backlog-exporter.git
cd hermes-backlog-exporter
npm install
```

### Configuration

Configuration parameters are stored in `./config.json`. 

- port: The port on which the Express server will run.
- api: The URL of the Hermes API.
- configFilePath: The path to the Hermes configuration file.
- dbPath: The path of the local database

### Run

To start, use the following command:

```bash
npm run start
```

### Metrics

You can access the metrics at `/metrics` on the server.

The following metrics are available:

- `packet_pending`: Number of total pending packets on a channel.
- `sequence_pending`: Pending status of a sequence.

### License

This project is licensed under the Apache License 2.0 - see the [LICENSE](./LICENSE) for details.