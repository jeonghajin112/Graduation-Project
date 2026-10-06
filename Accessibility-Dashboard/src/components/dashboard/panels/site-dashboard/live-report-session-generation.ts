export class LiveReportSessionGenerationFence {
  private readonly generations = new Map<number, number>();

  current(requestId: number): number {
    const currentGeneration = this.generations.get(requestId);
    if (currentGeneration !== undefined) {
      return currentGeneration;
    }
    this.generations.set(requestId, 0);
    return 0;
  }

  advance(requestId: number): number {
    const nextGeneration = this.current(requestId) + 1;
    this.generations.set(requestId, nextGeneration);
    return nextGeneration;
  }

  isCurrent(requestId: number, generation: number): boolean {
    return this.current(requestId) === generation;
  }

  clear(): void {
    // Cache cleanup may race with an already-settled promise whose continuation
    // is queued. Advance every known request instead of returning to generation
    // zero so those continuations remain permanently stale.
    for (const [requestId, generation] of this.generations) {
      this.generations.set(requestId, generation + 1);
    }
  }
}
