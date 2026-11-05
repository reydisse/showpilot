export const BRIDGE_TARGET_PROTOCOLS = [
    "atem", "dmx-artnet", "dmx-sacn", "http-command", "obs", "osc",
    "pjlink", "propresenter", "tcp-command", "udp", "visca-ip", "wol",
];
export class BridgeTargetError extends Error {
    code;
    constructor(code) {
        super(code === "unapproved-target"
            ? "This Bridge destination is not approved. Ask an integration administrator to approve its host, port and protocol in Settings."
            : code === "target-override"
                ? "Device settings cannot override the approved Bridge destination."
                : "Enter a valid Bridge host, port and protocol.");
        this.code = code;
    }
}
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function protocol(value) {
    const found = BRIDGE_TARGET_PROTOCOLS.find(item => item === value);
    if (!found)
        throw new BridgeTargetError("invalid-target");
    return found;
}
function port(value) {
    if (typeof value !== "number" && (typeof value !== "string" || !/^\d{1,5}$/.test(value)))
        throw new BridgeTargetError("invalid-target");
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
        throw new BridgeTargetError("invalid-target");
    return parsed;
}
/** Normalize the host only: no credentials, scheme, path, port, wildcard or URL suffix. */
export function normalizeBridgeHost(value) {
    if (typeof value !== "string")
        throw new BridgeTargetError("invalid-target");
    const host = value.trim().toLowerCase();
    if (!host || host.length > 253 || /[\s/@?#\\%*]/.test(host))
        throw new BridgeTargetError("invalid-target");
    // Bracketed IPv6 is kept bracketed for URL and target formatting.
    if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]")))
        throw new BridgeTargetError("invalid-target");
    let url;
    try {
        url = new URL(`http://${host}`);
    }
    catch {
        throw new BridgeTargetError("invalid-target");
    }
    if (url.port || url.username || url.password || url.pathname !== "/")
        throw new BridgeTargetError("invalid-target");
    const normalized = url.hostname.replace(/\.$/, "");
    if (!normalized.startsWith("[") && !normalized.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
        throw new BridgeTargetError("invalid-target");
    return normalized;
}
export function parseBridgeEndpoint(input) {
    if (!record(input))
        throw new BridgeTargetError("invalid-target");
    return { host: normalizeBridgeHost(input.host), port: port(input.port), protocol: protocol(input.protocol) };
}
function hostAndPort(target) {
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
    if (!match)
        throw new BridgeTargetError("invalid-target");
    return { host: normalizeBridgeHost(match[1]), port: port(match[2]) };
}
function httpTarget(target) {
    if ((target.includes("://") && !/^https?:\/\//i.test(target)) || /[\s\\]/.test(target))
        throw new BridgeTargetError("invalid-target");
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
    }
    catch {
        throw new BridgeTargetError("invalid-target");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new BridgeTargetError("invalid-target");
    normalizeBridgeHost(url.hostname);
    return url;
}
/** Enumerate actual destinations, including PP's API fallback, before any Bridge dispatch. */
export function resolveBridgeEndpoints(input) {
    if (!record(input) || !["command", "connect-device"].includes(String(input.type)) || typeof input.target !== "string")
        throw new BridgeTargetError("invalid-target");
    const kind = protocol(input.protocol);
    const target = input.target;
    if (!target || target.length > 2048 || target !== target.trim())
        throw new BridgeTargetError("invalid-target");
    const settings = input.settings === undefined ? {} : input.settings;
    if (!record(settings))
        throw new BridgeTargetError("invalid-target");
    let endpoint;
    if (kind === "wol") {
        if (target !== "wol")
            throw new BridgeTargetError("invalid-target");
        endpoint = { host: "255.255.255.255", port: 9, protocol: kind };
    }
    else if (kind === "http-command") {
        const url = httpTarget(target);
        endpoint = { host: normalizeBridgeHost(url.hostname), port: port(url.port || (url.protocol === "https:" ? 443 : 80)), protocol: kind };
        if (input.type === "command") {
            if (typeof input.command !== "string")
                throw new BridgeTargetError("invalid-target");
            const path = input.command.trim().replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, "").split(" ")[0];
            if (!path.startsWith("/") || /[\r\n\\]/.test(path))
                throw new BridgeTargetError("target-override");
            const destination = new URL(`${url.href.replace(/\/+$/, "")}${path}`);
            if (destination.origin !== url.origin)
                throw new BridgeTargetError("target-override");
        }
    }
    else {
        const address = kind === "propresenter" ? target.replace(/^propresenter:/, "") : target;
        endpoint = { ...hostAndPort(address), protocol: kind };
    }
    if (settings.host !== undefined && settings.host !== "" && normalizeBridgeHost(settings.host) !== endpoint.host)
        throw new BridgeTargetError("target-override");
    if (settings.port !== undefined && settings.port !== "" && port(settings.port) !== endpoint.port)
        throw new BridgeTargetError("target-override");
    const endpoints = [endpoint];
    if (kind === "propresenter" && input.type === "connect-device") {
        const apiPort = port(settings.apiPort ?? settings.api_port ?? settings["api-port"] ?? 1025);
        if (apiPort !== endpoint.port)
            endpoints.push({ ...endpoint, port: apiPort });
    }
    return endpoints;
}
