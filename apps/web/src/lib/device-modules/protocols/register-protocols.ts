import { registerProtocol } from "../profiles/profile-registry";
import { HttpCommandDriver } from "./http-command/http-command-driver";
import { PJLinkDriver } from "./pjlink/pjlink-driver";
import { TcpCommandDriver } from "./tcp-command/tcp-command-driver";
import { ViscaDriver } from "./visca/visca-driver";
import { WolDriver } from "./wol/wol-driver";

registerProtocol("http-command", (settings) => new HttpCommandDriver());
registerProtocol("pjlink", (settings) => new PJLinkDriver());
registerProtocol("tcp-command", (settings) => new TcpCommandDriver());
registerProtocol("visca-ip", (settings) => new ViscaDriver());
registerProtocol("wol", (settings) => new WolDriver());
