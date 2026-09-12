import { ProPresenterBridge } from "../dist/protocols/propresenter.js";

const [host, portValue, requestedPresentation] = process.argv.slice(2).filter((value) => value !== "--");
const port = Number(portValue ?? 1025);

if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Usage: node scripts/check-propresenter-import.mjs <host> [api-port] [presentation-uuid]");
  process.exit(1);
}

const bridge = new ProPresenterBridge({
  host,
  port,
  apiPort: port,
  onSlideChange: () => {},
  onStatusChange: () => {},
});

const listResponse = await bridge.sendCommand(JSON.stringify({ action: "query-presentations" }));
const presentations = JSON.parse(listResponse);
const presentationUuid = requestedPresentation ?? presentations[0]?.uuid;

if (!presentationUuid) {
  throw new Error("ProPresenter returned no presentations");
}

const detailResponse = await bridge.sendCommand(JSON.stringify({
  action: "query-presentation",
  presentationUuid,
}));
const detail = JSON.parse(detailResponse);

console.log(JSON.stringify({
  presentationCount: presentations.length,
  selected: {
    uuid: detail.uuid,
    name: detail.name,
    slideCount: detail.slides.length,
    slidesWithText: detail.slides.filter((slide) => slide.text.trim()).length,
  },
}, null, 2));
