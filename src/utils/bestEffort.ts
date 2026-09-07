export async function runBestEffort(
  operation: () => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    onError(error);
  }
}
