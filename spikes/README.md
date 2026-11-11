# M0 spikes

Six questions to answer before anything else is built. Each gets a folder with a short
RESULT.md: what was tried, pass or fail against the criterion, and what changes in the plan.

| # | Question | Pass criterion | Status |
|---|---|---|---|
| S1 | Do captured front-end files run offline at the original origin? | OpenEMR and OpenMRS O3 pages load from the store with no new console errors | passes on tiny-clinic and one public HTTPS site; EHRs not tried |
| S2 | Proxy or Playwright routing for replay? | Cookies, redirects, WebSockets and HTTP/2 work; a second tool can attach to the same Chrome | proxy (mockttp) chosen: cookies, redirects, HTTPS and attach work; WebSockets not replayed |
| S3 | Can we snapshot around a human's clicks? | Before/after snapshots for clicks in nested iframes and a pop-up window on OpenEMR | works on plain pages; iframes and pop-ups not tried |
| S4 | Agent SDK inside Docker with only the build set mounted | Runs, cannot read a canary file outside its mounts, stops at the dollar cap, resumes | not started |
| S5 | Local personal-data detection | 50 MB capture in under 10 minutes; recall measured on planted data | not started |
| S6 | Is the runtime contract right? | Two hand-written OpenEMR clusters pass L1-L3 | passes on tiny-clinic (9 hand-written handlers); OpenEMR not tried |
