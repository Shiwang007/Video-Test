import io from "socket.io-client";
import { Device } from "mediasoup-client";

const socket = io("/mediasoup");

let device;
let rtpCapabilities;
let sendTransport;
let recvTransport;
let producer;
const consumers = new Map();

const params = {
  encodings: [
    { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" },
    { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" },
    { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" },
  ],
  codecOptions: { videoGoogleStartBitrate: 1000 },
};

const getLocalStream = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      width: { min: 640, max: 1920 },
      height: { min: 400, max: 1080 },
    },
  });
  document.getElementById("localVideo").srcObject = stream;
  return stream;
};

const loadDevice = async (routerRtpCapabilities) => {
  if (!device) {
    device = new Device();
    await device.load({ routerRtpCapabilities });
  }
};

const createSendTransport = async () => {
  return new Promise((resolve) => {
    socket.emit("createWebRtcTransport", {}, async ({ params }) => {
      if (params.error) throw new Error(params.error);
      sendTransport = device.createSendTransport(params);

      sendTransport.on("connect", ({ dtlsParameters }, callback) => {
        socket.emit("transport-connect", { dtlsParameters });
        callback();
      });

      sendTransport.on("produce", ({ kind, rtpParameters }, callback) => {
        socket.emit("transport-produce", { kind, rtpParameters }, ({ id }) =>
          callback({ id })
        );
      });

      sendTransport.on("connectionstatechange", (state) => {
        if (state === "failed") sendTransport.close();
      });

      resolve();
    });
  });
};

const createRecvTransport = async () => {
  return new Promise((resolve) => {
    socket.emit("createWebRtcTransport", {}, async ({ params }) => {
      if (params.error) throw new Error(params.error);
      recvTransport = device.createRecvTransport(params);

      recvTransport.on("connect", ({ dtlsParameters }, callback) => {
        socket.emit("transport-connect", { dtlsParameters });
        callback();
      });

      recvTransport.on("connectionstatechange", (state) => {
        if (state === "failed") recvTransport.close();
      });

      resolve();
    });
  });
};

const publish = async () => {
  const stream = await getLocalStream();
  const track = stream.getVideoTracks()[0];

  socket.emit("getRtpCapabilities", async ({ rtpCapabilities: caps }) => {
    rtpCapabilities = caps;
    await loadDevice(caps);
    await createSendTransport();
    producer = await sendTransport.produce({ track, ...params });
  });
};

const consume = async (producerId) => {
  if (!rtpCapabilities || !device || !recvTransport) return;

  socket.emit(
    "consume",
    { rtpCapabilities, producerId },
    async ({ params }) => {
      if (params?.error) {
        console.warn("Consume error:", params.error);
        return;
      }

      const consumer = await recvTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      const remoteStream = new MediaStream([consumer.track]);

      // ✅ Create a unique <video> element for this producer
      const remoteVideo = document.createElement("video");
      remoteVideo.id = `remote-${producerId}`;
      remoteVideo.srcObject = remoteStream;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.width = 320;
      remoteVideo.height = 240;
      remoteVideo.controls = true;

      // ✅ Append to container (e.g., <div id="remoteContainer">)
      document.getElementById("remoteContainer").appendChild(remoteVideo);

      consumers.set(producerId, consumer);
    }
  );
};
// UI bindings

const publishBtn = document.getElementById("btnPublish");
const subscribeBtn = document.getElementById("btnSubscribe");

publishBtn.addEventListener("click", publish);

subscribeBtn.addEventListener("click", async () => {
  socket.emit("getRtpCapabilities", async ({ rtpCapabilities: caps }) => {
    rtpCapabilities = caps;
    await loadDevice(caps);
    await createRecvTransport();

    socket.emit("getProducers", (producers) => {
      producers.forEach(({ producerId, socketId }) => {
        // 👇 Skip consuming your own stream
        if (socketId !== socket.id && !consumers.has(producerId)) {
          consume(producerId);
        }
      });
    });
  });
});

// Listen for new producers
socket.on("new-producer", ({ producerId, socketId }) => {
  if (socketId !== socket.id && !consumers.has(producerId)) {
    consume(producerId);
  }
});
  