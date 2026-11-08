export class RundownMetadataConflictError extends Error {
  constructor(
    message = "This show changed on another device. Refresh and try again.",
  ) {
    super(message);
    this.name = "RundownMetadataConflictError";
  }
}
