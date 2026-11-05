import { approveBridgeTarget } from "@/lib/bridge-targets.server";
import { resolveBridgeEndpoints } from "@showpilot/shared/bridge-target";
import { env } from "cloudflare:workers";
import { issueBridgeInstallation } from "@/lib/bridge-credentials.server";

const internalHeaders = { Upgrade: "websocket", "x-showpilot-bridge-policy": "2", "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" };

export async function ensureBridgeTestOrg(orgId: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
    .bind(orgId, orgId, orgId).run();
}

export async function openTestBridge(orgId: string, existing?: Awaited<ReturnType<typeof issueBridgeInstallation>>) {
  await ensureBridgeTestOrg(orgId);
  const credential = existing ?? await issueBridgeInstallation(env.DB, { orgId, label: "Test Bridge", actorUserId: "test-owner" });
  const stub = env.BRIDGE_RELAY.getByName(orgId);
  const query = new URLSearchParams({ orgId, role: "bridge", authCredentialId: credential.credentialId });
  const response = await stub.fetch(new Request(`https://bridge.test/ws?${query}`, { headers: internalHeaders }));
  if (response.status !== 101 || !response.webSocket) throw new Error(`Bridge upgrade failed (${response.status})`);
  const socket = response.webSocket;
  let acknowledgeRoles = true;
  const ready = new Promise<void>(resolve => socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.type !== "bridge-role") return;
    if (acknowledgeRoles && message.selectionId) socket.send(JSON.stringify({ type: "bridge-role-applied", role: message.role, selectionId: message.selectionId }));
    resolve();
  }));
  socket.accept();
  await ready;
  return { stub, socket: response.webSocket, credential, setRoleAcknowledgment: (enabled: boolean) => { acknowledgeRoles = enabled; } };
}

export async function bridgeClientTestRequest(orgId: string): Promise<Request> {
  await ensureBridgeTestOrg(orgId);
  const userId = `${orgId}-operator`;
  const sessionId = `${orgId}-session`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, 'Bridge operator', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(userId, `${userId}@example.test`),
    env.DB.prepare(`INSERT OR IGNORE INTO session (id, expiresAt, token, createdAt, updatedAt, userId, activeOrganizationId)
      VALUES (?, '2099-01-01T00:00:00.000Z', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`).bind(sessionId, sessionId, userId, orgId),
    env.DB.prepare(`INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt)
      VALUES (?, ?, ?, 'owner', CURRENT_TIMESTAMP)`).bind(`${orgId}-member`, orgId, userId),
  ]);
  return new Request(`https://bridge.test/ws?${new URLSearchParams({ orgId, role: "client", authUserId: userId, authSessionId: sessionId })}`, { headers: internalHeaders });
}

export async function approveTestBridgeTarget(orgId: string, protocol: string, target: string, settings: Record<string, unknown> = {}) {
  for (const endpoint of resolveBridgeEndpoints({ type: "connect-device", protocol, target, settings })) {
    await approveBridgeTarget(env.DB, { orgId, endpoint, label: "Fixture destination", actorUserId: "fixture-admin" });
  }
}
