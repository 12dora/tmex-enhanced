# tmex split hub-e2e report

- date: 2026-08-28T20:17:58Z
- image: tmex-e2e:split
- tarball: /Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/build/tmex-cli.tgz
- hub: https://ai.jiefakj.com:18443
- hub host/ip: ai.jiefakj.com / 43.248.129.233
- tls: letsencrypt
- remote: root@43.248.129.233:/root/tmex-e2e
- lan netem: delay 80ms rate 16mbit

| scenario | result | evidence |
|---|---|---|
| A0 hub /healthz via public HTTPS | PASS |  |
| A0b hub user add alice | PASS |  |
| A0c /api/auth/mode mesh fields | PASS |  |
| A1 enroll+join node-a and node-b over internet | PASS |  |
| A2 login hub entry https://ai.jiefakj.com:18443 | PASS |  |
| A3 /api/hub/nodes both online | PASS |  |
| A4 resolve node ids | PASS |  |
| A5 login node-a via hub | PASS |  |
| A6 create local device on node-a | PASS |  |
| A7 terminal marker round-trip on node-a through hub (relay) | PASS |  |
| A5b login node-b via hub | PASS |  |
| A8 files list+read on node-b through hub | PASS |  |
| B1 login node-a entry | PASS |  |
| B2 node-a mesh lists hub isHub:true 508d58b8eaabf284a32b0dbe5723c9e6 | PASS |  |
| B3 login remote hub node via node-a | PASS |  |
| B4 create local device on hub container | PASS |  |
| B5 tmux tree on hub via node-a | PASS |  |
| B6 terminal marker node-a → remote hub node (reach=relay) | PASS |  |
| C1 node-a sees node-b reach=lan within 90s | PASS |  |
| C2 terminal marker via LAN | PASS |  |
| C3 terminal marker with remote hub down | PASS |  |
| C4 file list with remote hub down | PASS |  |
| C5 /api/mesh/nodes still lists node-b | PASS |  |
| C6 both nodes online on hub within 120s | PASS |  |
| C7 existing hub cookies still valid | PASS |  |
| E1 docker restart node-a re-uplinks, app.env intact | PASS |  |
| E2 node-a still reaches hub node after restart | FAIL | E2 node-a still reaches hub node after restart |
| E3 remote hub restart, nodes reconnect, no ghost rows | PASS |  |
| L1 both rows direct_capable=true | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L2 transport=dc | PASS | {"reach":"lan","transport":"dc","direct_capable":true}; qdisc node-a[eth0]=qdisc netem 8021: root refcnt 11 limit 1000 delay 80ms rate 16Mbit; node-b[eth0]=qdisc netem 8022: root refcnt 11 limit 1000 delay 80ms rate 16Mbit |
| L3 marker round-trip while transport=dc | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L4 transport falls back to ws-secure within 30s | PASS | mode=iptables drop_rc=0 |
| L5 SEQ_1..400 contiguous on entry stream | PASS | {"ok":true,"expectCount":400,"seqPrefix":"SEQ_","foundCount":400,"fromHistory":400,"fromOutput":190,"first":1,"last":400,"missing":[],"missingCount":0,"extra":[],"contiguous":true,"complete":true,"opened":true,"helloOk":true,"connected":true,"elapsedMs":16696}  |
| L6 transport returns to dc within 90s | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L7 8MiB sha256 over dc | PASS | sha256=5e7251a87b27d4aefc5fe37ec550cb30fdebdefd7704b99a40a56662535864ed {"bytes":8388608,"headers":{"content-type":"application/octet-stream"},"bulkPath":"browser-only"}; bulk DataChannel is browser-only (BulkClient bulk:<id>), REST /api/files/raw rides the mesh link |
| L8 8MiB sha256 with UDP drop (REST fallback) | PASS | relay_wait=1 sha256=5e7251a87b27d4aefc5fe37ec550cb30fdebdefd7704b99a40a56662535864ed {"bytes":8388608,"headers":{"content-type":"application/octet-stream"},"bulkPath":"browser-only"} |
| D1 both rows direct_capable=true | PASS | {"reach":"relay","transport":"relay","direct_capable":true} |
| D2 transport=dc | FAIL | stayed relay/other path={"reach":"relay","transport":"relay","direct_capable":true}; node-a=[mesh][rtc] dial failed peer=508d58b8eaabf284a32b0dbe5723c9e6 reason=datachannel open timeout fallback=ws-secure; hub=[mesh][rtc] datachannel created peer=6b826b971cc78be401a537976379578e label=peer |
| D3 marker round-trip while transport=dc | FAIL | marker ok but transport not dc {"reach":"relay","transport":"relay","direct_capable":true} |
| H1 transport falls back to relay within 30s | SKIP | requires D2 transport=dc transport=dc |
| H2 SEQ_1..400 contiguous on entry stream | SKIP | requires D2 transport=dc transport=dc |
| H3 transport returns to dc within 90s | SKIP | requires D2 transport=dc transport=dc |
| I1 8MiB sha256 over dc | SKIP | requires D2 transport=dc transport=dc |
| I2 8MiB sha256 with UDP drop (REST fallback) | SKIP | requires D2 transport=dc transport=dc |
| F Playwright login + sidebar + terminal + passkey | PASS |  |
| G node-b unreachable after revoke | PASS |  |
