export class LoadingActivityCounter {
  private count = 0;

  begin(): true {
    this.count += 1;
    return true;
  }

  end(): boolean {
    this.count = Math.max(0, this.count - 1);
    return this.count > 0;
  }
}

export class TrailingQueryGate {
  private generation = 0;
  private inFlight: { generation: number; promise: Promise<unknown> } | null = null;

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  run<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (this.inFlight) {
      if (this.inFlight.generation === generation) return this.inFlight.promise as Promise<T>;
      return this.inFlight.promise.then(
        () => this.run(operation),
        () => this.run(operation),
      );
    }

    const promise = operation(generation);
    this.inFlight = { generation, promise };
    void promise
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null;
      })
      .catch(() => undefined);
    return promise;
  }
}
