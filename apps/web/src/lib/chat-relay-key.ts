export function chatRelayKey(orgId: string, roomId: string): string {
	return `${orgId}:${roomId}`;
}
