// Each Worker test file has its own database and module instance. Within that
// instance, use a distinct address for each independent fixture login so auth
// throttling tests remain the only tests that intentionally reuse an address.
let nextAddress = 0;
export function nextFixtureAddress(): string {
  const index = nextAddress++;
  if (index >= 64_000) throw new Error("Fixture address range exhausted");
  return `198.18.${Math.floor(index / 250)}.${index % 250 + 1}`;
}
