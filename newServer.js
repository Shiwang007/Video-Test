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

app.use("/sfu", express.static(path.join(__dirname, "public"))); // Use the existing __dirname

// const options = {
//   pfx: fs.readFileSync(
//     require("path").join(
//       require("os").homedir(),
//       "Desktop",
//       "mediasoup-cert.pfx"
//     )
//   ),
//   passphrase: "password",
// };

const httpServer = http.createServer(app);
// const httpsServer = https.createServer(options, app);
const io = new Server(httpServer);

const peers = io.of("/mediasoup");

let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;
const consumers = {}; // To store consumers by their socketId

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
};

createWorker().then((w) => {
  worker = w;
});

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

peers.on("connection", async (socket) => {
  console.log(socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
  });

  // Only create the router once, not per connection
  if (!router) {
    router = await worker.createRouter({ mediaCodecs });
  }

  socket.on("disconnect", () => {
    console.log("peer disconnected");
    // Cleanup when the peer disconnects
    if (consumer) {
      consumer.close();
    }
  });

  socket.on("getRtpCapabilities", (callback) => {
    const rtpCapabilities = router.rtpCapabilities;
    console.log("rtp Capabilities", rtpCapabilities);
    callback({ rtpCapabilities });
  });

  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    if (sender) {
      // Producer transport for sending audio (i.e., admin or any user transmitting)
      producerTransport = await createWebRtcTransport(callback);
    } else {
      // Consumer transport for receiving audio (i.e., normal users consuming audio)
      consumerTransport = await createWebRtcTransport(callback);
    }
  });

  socket.on("transport-connect", async ({ dtlsParameters }) => {
    if (producerTransport) {
      await producerTransport.connect({ dtlsParameters });
    } else if (consumerTransport) {
      await consumerTransport.connect({ dtlsParameters });
    }
  });

  socket.on(
    "transport-produce",
    async ({ kind, rtpParameters, appData }, callback) => {
      producer = await producerTransport.produce({
        kind,
        rtpParameters,
      });

      console.log("Producer ID: ", producer.id, producer.kind);

      producer.on("transportclose", () => {
        console.log("transport for this producer closed");
        producer.close();
      });

      callback({
        id: producer.id,
      });
    }
  );

  socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    try {
      if (
        producer &&
        router.canConsume({
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: false, // Change from true to false to avoid starting muted
        });

        consumers[socket.id] = consumer; // Save the consumer with the socketId

        consumer.on("transportclose", () => {
          console.log("consumer transport closed");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
        });

        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        callback({ params });
      }
    } catch (error) {
      console.log(error.message);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("consumer-resume", async () => {
    console.log("consumer resume");
    if (consumer) {
      await consumer.resume();
    }
  });

  // Admin mute/unmute functionality
  socket.on("muteUser", (targetSocketId) => {
    const targetConsumer = consumers[targetSocketId];
    if (targetConsumer) {
      targetConsumer.pause(); // Mute the user
      console.log(`Muted user: ${targetSocketId}`);
    }
  });

  socket.on("unmuteUser", (targetSocketId) => {
    const targetConsumer = consumers[targetSocketId];
    if (targetConsumer) {
      targetConsumer.resume(); // Unmute the user
      console.log(`Unmuted user: ${targetSocketId}`);
    }
  });
});

const createWebRtcTransport = async (callback) => {
  try {
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: process.env.RENDER_EXTERNAL_HOSTNAME,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    };

    let transport = await router.createWebRtcTransport(webRtcTransport_options);
    console.log(`transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log("transport closed");
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
    callback({
      params: {
        error: error,
      },
    });
  }
};

httpServer.listen(process.env.PORT || 3000, () => {
  console.log("listening on port: 3000 (HTTPS)");
});
