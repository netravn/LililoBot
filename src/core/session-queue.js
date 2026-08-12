export class SessionQueue {
  #tails = new Map();

  async run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, current);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    }
  }
}
