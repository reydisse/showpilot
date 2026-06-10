import { registerProtocol } from "../profiles/profile-registry";
import { HttpCommandDriver } from "./http-command/http-command-driver";
import { PJLinkDriver } from "./pjlink/pjlink-driver";
import { TcpCommandDriver } from "./tcp-command/tcp-command-driver";
import { ViscaDriver } from "./visca/visca-driver";
import { WolDriver } from "./wol/wol-driver";

registerProtocol("http-command", () => new HttpCommandDriver());
registerProtocol("pjlink", () => new PJLinkDriver());
registerProtocol("tcp-command", () => new TcpCommandDriver());
registerProtocol("visca-ip", () => new ViscaDriver());
registerProtocol("wol", () => new WolDriver());
