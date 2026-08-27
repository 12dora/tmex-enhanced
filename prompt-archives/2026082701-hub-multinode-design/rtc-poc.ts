import nodeDataChannel from 'node-datachannel';


const cfg = { iceServers: ['stun:stun.l.google.com:19302'] };
const p1 = new nodeDataChannel.PeerConnection('p1', cfg);
const p2 = new nodeDataChannel.PeerConnection('p2', cfg);

p1.onLocalDescription((sdp, type) => p2.setRemoteDescription(sdp, type));
p1.onLocalCandidate((c, mid) => { console.log('cand', c); p2.addRemoteCandidate(c, mid); });
p2.onLocalDescription((sdp, type) => p1.setRemoteDescription(sdp, type));
p2.onLocalCandidate((c, mid) => p1.addRemoteCandidate(c, mid));

const start = Date.now();
let received = 0;
const N = 2000;
const payload = new Uint8Array(16 * 1024);

p2.onDataChannel((dc) => {
  dc.onMessage((msg) => {
    received++;
    if (received === N) {
      const ms = Date.now() - start;
      console.log(`OK: ${N} x 16KiB in ${ms}ms (${((N * 16) / 1024 / (ms / 1000)).toFixed(1)} MiB/s)`);
      console.log('selected pair:', p1.getSelectedCandidatePair());
      dc.close(); p1.close(); p2.close();
      setTimeout(() => process.exit(0), 200);
    }
  });
});

const dc1 = p1.createDataChannel('tmex');
dc1.onOpen(() => {
  console.log('open after', Date.now() - start, 'ms');
  for (let i = 0; i < N; i++) dc1.sendMessageBinary(payload);
});

setTimeout(() => { console.log('TIMEOUT received=', received); process.exit(1); }, 20000);
