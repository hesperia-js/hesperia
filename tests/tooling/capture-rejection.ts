/** Capture an async failure without routing native checker work through Bun's rejects matcher. */
export async function captureRejection<T>(operation: Promise<T>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to reject");
}
