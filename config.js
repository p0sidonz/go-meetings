module.exports = {
  listenIp: "0.0.0.0",
  listenPort: 3000,
  sslCrt: "server.cert",
  sslKey: "server.key",

  mediasoup: {
    // Worker settings
    numWorkers: Object.keys(require("os").cpus()).length,
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: "warn",
      logTags: [
        "info",
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp",
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc',
        // 'sctp',
      ],
    },
    // Router settings
    router: {
      mediaCodecs: [
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
      ],
    },
    // WebRtcTransport settings
    webRtcTransport: {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: "192.168.1.6", // Replace with public IP if deploying
        },
      ],
      maxIncomingBitrate: 1500000,
      initialAvailableOutgoingBitrate: 1000000,
    },
  },
};
