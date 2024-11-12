//index.js
const io = require("socket.io-client");
const mediasoupClient = require("mediasoup-client");

const roomName = window.location.pathname.split("/")[2];
let roomHasMembersAlready = false;

let requestButton = document.getElementById("forAdmin");

if (requestButton) {
  requestButton.addEventListener("click", () => {
    console.log("request sent!!!", socket);

    socket.emit("requestToJoinLive", { roomName });
    requestButton.style.display = "none";
  });
}

const socket = io("/mediasoup", {
  query: {
    roomName,
  },
});

socket.on("connection-success", async ({ socketId, hasMembers }) => {
  console.log(socketId);
  roomHasMembersAlready = hasMembers;
  // STEP 1: Get user audio video stream
  if (!hasMembers) {
    await getLocalStream();
  } else {
    joinRoom();
    if (requestButton) requestButton.style.display = "block";
  }
});

const ask = () => confirm("SomeOne wants to join the live");

socket.on("requestForJoiningLive", (sockerId) => {
  console.log("event triggered");
  let response = ask();
  if (response) {
    socket.emit("allowToJoin", sockerId);
  }
});

socket.on("requestAccepted", async () => {
  await getLocalStream(false);
  createSendTransport();
});

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransports = [];
let audioProducer;
let videoProducer;
let consumer;
let isProducer = false;

// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions
// https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
let params = {
  // mediasoup params
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "L3T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "L3T3",
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "L3T3",
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

let audioParams;
let videoParams = { params };
let consumingTransports = [];

const streamSuccess = (stream, shouldJoinRoom) => {
  console.log("stream success is called");
  localVideo.srcObject = stream;

  audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
  // console.log("audioParams::::", audioParams);
  videoParams = { track: stream.getVideoTracks()[0], ...videoParams };
  // console.log("audioParams",audioParams);
  // console.log("videoParams",videoParams);
  if (shouldJoinRoom) joinRoom();
};

const joinRoom = () => {
  socket.emit("joinRoom", { roomName }, (data) => {
    console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);
    // we assign to local variable and will be used when
    // loading the client Device (see createDevice above)
    rtpCapabilities = data.rtpCapabilities;

    // once we have rtpCapabilities from the Router, create Device
    createDevice(); // IMPORTANT STEP for sending stream
  });
};

// Getting user audio and video stream
const getLocalStream = async (shouldJoinRoom = true) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: {
          min: 640,
          max: 1920,
        },
        height: {
          min: 400,
          max: 1080,
        },
      },
    });
    streamSuccess(stream, shouldJoinRoom);
  } catch (error) {
    console.log(error.message);
  }
};

// A device is an endpoint connecting to a Router on the
// server side to send/recive media
const createDevice = async () => {
  try {
    device = new mediasoupClient.Device();

    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
    // Loads the device with RTP capabilities of the Router (server side)
    await device.load({
      // see getRtpCapabilities() below
      routerRtpCapabilities: rtpCapabilities,
    });

    // console.log("Device RTP Capabilities", device.rtpCapabilities);

    // once the device loads, create transport
    console.log(
      "roomHasMembersAlready::::",
      roomHasMembersAlready,
      device.loaded
    );

    if (!roomHasMembersAlready) {
      createSendTransport();
    } else {
      getProducers();
    }
  } catch (error) {
    console.log(error);
    if (error.name === "UnsupportedError")
      console.warn("browser not supported");
  }
};

const createSendTransport = () => {
  console.log("createSendTransport is called");
  // see server's socket.on('createWebRtcTransport', sender?, ...)
  // this is a call from Producer, so sender = true
  socket.emit("createWebRtcTransport", { consumer: false }, ({ params }) => {
    // The server sends back params needed
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error);
      return;
    }

    // console.log(params);

    // creates a new WebRTC Transport to send media
    // based on the server's producer transport params
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
    producerTransport = device.createSendTransport(params);

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectSendTransport() below
    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          // see server's socket.on('transport-connect', ...)
          await socket.emit("transport-connect", {
            dtlsParameters,
          });

          // Tell the transport that parameters were transmitted.
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    producerTransport.on("produce", async (parameters, callback, errback) => {
      // console.log(parameters);
      console.log(" producerTransport listner ");
    
      try {
        // tell the server to create a Producer
        // with the following parameters and produce
        // and expect back a server side producer id
        // see server's socket.on('transport-produce', ...)
        await socket.emit(
          "transport-produce",
          {
            kind: parameters.kind,
            rtpParameters: parameters.rtpParameters,
            appData: parameters.appData,
          },
          ({ id, producersExist }) => {
            // Tell the transport that parameters were transmitted and provide it with the
            // server side producer's id.
            callback({ id });

            // if producers exist, then join room
            // This is to consume the all other joined users
            // console.log("id and producersExist in transport  produce",id,producersExist);
            if (producersExist){
              // console.log("producersExist",producersExist);
              getProducers();
            } 
          }
        );
      } catch (error) {
        errback(error);
      }
    });
    connectSendTransport();
  });
};

const connectSendTransport = async () => {
  // we now call produce() to instruct the producer transport
  // to send media to the Router
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
  // this action will trigger the 'connect' and 'produce' events above

  // console.log(audioParams);
  // console.log(videoParams);
  audioProducer = await producerTransport.produce(audioParams);

  // console.log("audioProducer::::",audioProducer)
  videoProducer = await producerTransport.produce(videoParams);

  audioProducer.on("trackended", () => {
    console.log("audio track ended");

    // close audio track
  });

  audioProducer.on("transportclose", () => {
    console.log("audio transport ended");

    // close audio track
  });

  videoProducer.on("trackended", () => {
    console.log("video track ended");

    // close video track
  });

  videoProducer.on("transportclose", () => {
    console.log("video transport ended");

    // close video track
  });
};

const signalNewConsumerTransport = async (remoteProducerId) => {
  //check if we are already consuming the remoteProducerId
  if (consumingTransports.includes(remoteProducerId)) return;
  consumingTransports.push(remoteProducerId);
  // console.log("");
  console.log("creating createWebRtcTransport");
  await socket.emit(
    "createWebRtcTransport",
    { consumer: true },

    ({ params }) => {
      // The server sends back params needed
      // to create Send Transport on the client side
      if (params.error) {
        console.log(params.error);
        return;
      }
      // console.log(`CONSUME PARAMS... `, params);
      let consumerTransport;
      try {
        consumerTransport = device.createRecvTransport(params);
      } catch (error) {
        // exceptions:
        // {InvalidStateError} if not loaded
        // {TypeError} if wrong arguments.
        console.log(error);
        return;
      }

      consumerTransport.on(
        "connect",
        async ({ dtlsParameters }, callback, errback) => {
          // console.log("dtlsParameters::::::", dtlsParameters);
          try {
            // Signal local DTLS parameters to the server side transport
            // see server's socket.on('transport-recv-connect', ...)
            await socket.emit("transport-recv-connect", {
              dtlsParameters,
              serverConsumerTransportId: params.id,
            });

            // Tell the transport that parameters were transmitted.
            callback();
          } catch (error) {
            // Tell the transport that something was wrong
            errback(error);
          }
        }
      );

      // remoteProducerId === Kisko consume krna hai
      connectRecvTransport(consumerTransport, remoteProducerId, params.id);
    }
  );
};

// server informs the client of a new producer just joined
socket.on("new-producer", ({ producerId }) =>{
  console.log("new-producer",producerId);
  signalNewConsumerTransport(producerId)
  }
);

const getProducers = () => {

  console.log("enter in the get producers::::::::::")
  socket.emit("getProducers", (producerIds) => {
    console.log("Get producers called",producerIds);
    // console.log(producerIds);
    // for each of the producer create a consumer
    // producerIds.forEach(id => signalNewConsumerTransport(id))
    producerIds.forEach(signalNewConsumerTransport);
  });
};

const connectRecvTransport = async (
  consumerTransport,
  remoteProducerId,
  serverConsumerTransportId
) => {
  // for consumer, we need to tell the server first
  // to create a consumer based on the rtpCapabilities and consume
  // if the router can consume, it will send back a set of params as below
  await socket.emit(
    "consume",
    {
      rtpCapabilities: device.rtpCapabilities,
      remoteProducerId,
      serverConsumerTransportId,
    },

    async ({ params }) => {
      console.log("'''Consume is running'''");
      console.log("here is the remote producer id::::", remoteProducerId);
      if (params.error) {
        console.log("Cannot Consume");
        return;
      }

      // console.log(`Consumer Params`, params);
      // then consume with the local consumer transport
      // which creates a consumer
      const consumer = await consumerTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      consumerTransports = [
        ...consumerTransports,
        {
          consumerTransport,
          serverConsumerTransportId: params.id,
          producerId: remoteProducerId,
          consumer,
        },
      ];

      // console.log("params::::", params);

      // create a new div element for the new consumer media
      const newElem = document.createElement("div");
      newElem.setAttribute("id", `td-${remoteProducerId}`);

      if (params.kind == "audio") {
        //append to the audio container
        newElem.innerHTML =
          '<audio id="' + remoteProducerId + '" autoplay></audio>';
      } else {
        //append to the video container
        newElem.setAttribute("class", "remoteVideo");
        // newElem.setAttribute("autoplay", true);
        // newElem.setAttribute("playsInline", true);
        newElem.innerHTML =
          '<video id="' +
          remoteProducerId +
          '" autoplay class="video" ></video>';
      }

      videoContainer.appendChild(newElem);

      document.body.addEventListener(
        "click",
        () => {
          console.log("onlick is working....");
          const videoElement = document.getElementById(remoteProducerId);
          videoElement
            ?.play()
            .catch((error) => console.error("Play error:", error));
        },
        { once: true }
      );

      // destructure and retrieve the video track from the producer
      const { track } = consumer;

      // console.log("consumer",consumer);
      // console.log("track",track);
      

      // console.log(
      //   "track::::",
      //   track,
      //   document.getElementById(remoteProducerId)
      // );

      document.getElementById(remoteProducerId).srcObject = new MediaStream([
        track,
      ]);

      // the server consumer started with media paused
      // so we need to inform the server to resume
      socket.emit("consumer-resume", {
        serverConsumerId: params.serverConsumerId,
      });
    }
  );
};

socket.on("producer-closed", ({ remoteProducerId }) => {
  // server notification is received when a producer is closed
  // we need to close the client-side consumer and associated transport


  console.log("producer closed.........")
  const producerToClose = consumerTransports.find(
    (transportData) => transportData.producerId === remoteProducerId
  );
  producerToClose.consumerTransport.close();
  producerToClose.consumer.close();

  // remove the consumer transport from the list
  consumerTransports = consumerTransports.filter(
    (transportData) => transportData.producerId !== remoteProducerId
  );

  videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`));
});
