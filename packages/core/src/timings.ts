/** One acknowledged `POST /topics/timings`: the floors it reported and the topic time it carried. */
export interface TimingsReceipt {
  topicId: string;
  postNumbers: number[];
  topicMs: number;
}

/**
 * Sums the site's read receipts. The screen tracker reports a floor again in every flush while it
 * stays on screen, so floors are counted once per topic and post number.
 */
export class TimingsTally {
  private readonly floors = new Set<string>();
  private topicMs = 0;

  add(receipt: TimingsReceipt): void {
    for (const n of receipt.postNumbers) this.floors.add(`${receipt.topicId}#${n}`);
    this.topicMs += receipt.topicMs;
  }

  snapshot(): { posts: number; topicSeconds: number } {
    return { posts: this.floors.size, topicSeconds: Math.round(this.topicMs / 100) / 10 };
  }
}
