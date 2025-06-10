const express = require("express");
const app = express();

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});

app.use("/sfu", express.static(path.join(__dirname, "public")));

const options = {
  pfx: fs.readFileSync(
    path.join(require("os").homedir(), "Desktop", "mediasoup-cert.pfx")
  ),
  passphrase: "password",
};

const httpServer = http.createServer(app);
const httpsServer = https.createServer(options, app);
const io = new Server(httpsServer);

const peers = io.of("/mediasoup");

let worker;
let router;

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

const transports = {};
const producers = {};
const consumers = {};

const createWorker = async () => {
  const worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);
  worker.on("died", () => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });
  return worker;
};

(async () => {
  worker = await createWorker();
  router = await worker.createRouter({ mediaCodecs });

  peers.on("connection", async (socket) => {
    console.log(`${socket.id} connected`);
    socket.emit("connection-success", { socketId: socket.id });

    transports[socket.id] = null;
    producers[socket.id] = [];
    consumers[socket.id] = [];

    socket.on("disconnect", () => {
      if (transports[socket.id]) {
        try {
          transports[socket.id].close();
        } catch {}
        delete transports[socket.id];
      }
      producers[socket.id]?.forEach((p) => p.close());
      consumers[socket.id]?.forEach((c) => c.close());
      delete producers[socket.id];
      delete consumers[socket.id];
    });

    socket.on("getRtpCapabilities", (callback) => {
      callback({ rtpCapabilities: router.rtpCapabilities });
    });

    socket.on("createWebRtcTransport", async (_, callback) => {
      const transport = await createWebRtcTransport(callback);
      transports[socket.id] = transport;
    });

    socket.on("transport-connect", async ({ dtlsParameters }) => {
      const transport = transports[socket.id];
      if (transport) await transport.connect({ dtlsParameters });
    });

    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters }, callback) => {
        const transport = transports[socket.id];
        const producer = await transport.produce({ kind, rtpParameters });
        producers[socket.id].push(producer);
        producer.on("transportclose", () => producer.close());
        callback({ id: producer.id });
        socket.broadcast.emit("new-producer", {
          producerId: producer.id,
          socketId: socket.id,
        });
      }
    );

    socket.on("consume", async ({ rtpCapabilities, producerId }, callback) => {
      try {
        let foundProducer = null;
        for (const sid in producers) {
          foundProducer = producers[sid].find((p) => p.id === producerId);
          if (foundProducer) break;
        }

        if (
          foundProducer &&
          router.canConsume({ producerId: foundProducer.id, rtpCapabilities })
        ) {
          const transport = transports[socket.id];
          const consumer = await transport.consume({
            producerId: foundProducer.id,
            rtpCapabilities,
            paused: false,
          });
          consumers[socket.id].push(consumer);
          consumer.on("transportclose", () => consumer.close());
          consumer.on("producerclose", () => consumer.close());
          const params = {
            id: consumer.id,
            producerId: foundProducer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          };
          callback({ params });
        } else {
          callback({ params: { error: "Cannot consume" } });
        }
      } catch (err) {
        callback({ params: { error: err.message } });
      }
    });

    socket.on("consumer-resume", async () => {
      for (const consumer of consumers[socket.id] || []) {
        try {
          await consumer.resume();
        } catch (e) {
          console.error(e);
        }
      }
    });
    socket.on("getProducers", (callback) => {
      const allProducers = [];
      for (const sid in producers) {
        producers[sid].forEach((p) =>
          allProducers.push({ producerId: p.id, socketId: sid })
        );
      }
      callback(allProducers); // Make sure this is present
    });
  });

  httpsServer.listen(process.env.PORT || 3000, () => {
    console.log("listening on port: 3000 (HTTPS)");
  });
})();

const createWebRtcTransport = async (callback) => {
  try {
    const transport = await router.createWebRtcTransport({
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: process.env.RENDER_EXTERNAL_HOSTNAME || "192.168.1.28",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") transport.close();
    });

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });

    return transport;
  } catch (error) {
    console.log(error);
    callback({ params: { error: error.message } });
  }
};
