export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private generation = 0;
  private cancel: (() => void) | null = null;

  stop(): void {
    this.generation += 1;
    this.cancel?.();
    this.cancel = null;
    this.release();
  }

  get currentGeneration(): number {
    return this.generation;
  }

  async play(data: ArrayBuffer, mime: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.release();
    const url = URL.createObjectURL(new Blob([data], { type: mime || "audio/mpeg" }));
    const audio = new Audio(url);
    this.audio = audio;
    this.url = url;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("error", onError);
        if (this.cancel === settleQuietly) this.cancel = null;
        if (this.audio === audio) this.release();
      };
      const settleQuietly = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (generation !== this.generation) resolve();
        else reject(new Error("浏览器没有把这段语音播出来"));
      };
      this.cancel = settleQuietly;
      audio.addEventListener("ended", onEnd);
      audio.addEventListener("error", onError);
      audio.play().then(() => {
        return;
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (generation !== this.generation) {
          resolve();
          return;
        }
        reject(error instanceof Error ? error : new Error("无法开始朗读"));
      });
    });
  }

  private release(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}
