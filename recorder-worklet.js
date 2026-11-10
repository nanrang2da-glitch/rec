// 마이크 입력을 16kHz 모노로 줄여서 메인 스레드로 보냅니다.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.target; // 예: 48000 / 16000 = 3
    this.acc = 0;
    this.count = 0;
    this.pos = 0;
    this.buf = new Float32Array(4000); // 0.25초 단위로 전송
    this.len = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.acc += v;
      this.count++;
      this.pos += 1;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.buf[this.len++] = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        if (this.len === this.buf.length) {
          this.port.postMessage({ samples: this.buf, peak: this.peak }, [this.buf.buffer]);
          this.buf = new Float32Array(4000);
          this.len = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
