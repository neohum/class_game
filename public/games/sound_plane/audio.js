class AudioManager {
    constructor() {
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.isInitialized = false;
    }

    async init() {
        if (this.isInitialized) return true;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            
            // 피치 분석을 위해 FFT 사이즈 증가
            this.analyser.fftSize = 2048;

            this.microphone = this.audioContext.createMediaStreamSource(stream);
            this.microphone.connect(this.analyser);
            
            this.isInitialized = true;
            return true;
        } catch (err) {
            console.error('마이크 접근 오류:', err);
            alert('게임 플레이를 위해 마이크 접근을 허용해주세요.');
            return false;
        }
    }

    getPitch() {
        if (!this.analyser) return { pitch: -1 };

        const buf = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(buf);
        const sampleRate = this.audioContext.sampleRate;

        // Auto-correlation 알고리즘을 이용해 피치 주파수(Hz) 계산
        let pitch = autoCorrelate(buf, sampleRate);
        return { pitch: pitch };
    }

    resumeContext() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }
}

// McLeod Pitch Method (MPM) 기반의 Auto-correlation
function autoCorrelate(buf, sampleRate) {
    var size = buf.length;
    var rms = 0;

    // 소리 크기 체크
    for (var i = 0; i < size; i++) {
        var val = buf[i];
        rms += val * val;
    }
    rms = Math.sqrt(rms / size);
    
    // 민감도 적용 (너무 작은 소리는 무시)
    let threshold = 0.01 / (window.micSensitivity || 1.2);
    if (rms < threshold) return -1;

    // 양쪽 끝 버퍼 잘라내기
    var r1 = 0, r2 = size - 1, thres = 0.2;
    for (var i = 0; i < size / 2; i++)
        if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    for (var i = 1; i < size / 2; i++)
        if (Math.abs(buf[size - i]) < thres) { r2 = size - i; break; }

    buf = buf.slice(r1, r2);
    size = buf.length;

    var c = new Array(size).fill(0);
    for (var i = 0; i < size; i++)
        for (var j = 0; j < size - i; j++)
            c[i] = c[i] + buf[j] * buf[j + i];

    var d = 0; while (c[d] > c[d + 1]) d++;
    var maxval = -1, maxpos = -1;
    for (var i = d; i < size; i++) {
        if (c[i] > maxval) {
            maxval = c[i];
            maxpos = i;
        }
    }
    var T0 = maxpos;

    if (T0 === 0) return -1;

    // 부드러운 피치 곡선을 위한 파라볼릭 보간
    var x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    var a = (x1 + x3 - 2 * x2) / 2;
    var b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);

    return sampleRate / T0;
}

window.audioManager = new AudioManager();
