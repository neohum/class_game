const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// === UI Elements ===
const startScreen = document.getElementById('start-screen');
const gameoverScreen = document.getElementById('gameover-screen');
const hud = document.getElementById('hud');
const scoreEl = document.getElementById('current-score');
const finalScoreEl = document.getElementById('final-score');
const volBar = document.getElementById('vol-bar');

const btnPractice = document.getElementById('btn-practice');
const btnCave = document.getElementById('btn-cave');
const btnRetry = document.getElementById('btn-retry');
const btnMenu = document.getElementById('btn-menu');
const btnBack = document.getElementById('btn-back');

// === Pitch Data ===
const noteKorean = ["도", "도#", "레", "레#", "미", "파", "파#", "솔", "솔#", "라", "라#", "시"];

function noteFromPitch(frequency) {
    let noteNum = 12 * (Math.log(frequency / 440) / Math.log(2));
    return Math.round(noteNum) + 69;
}

function getNoteName(note) {
    let name = noteKorean[note % 12];
    let octave = Math.floor(note / 12) - 1;
    return `${name}${octave}`;
}

const MIN_NOTE = 45; // A2 (낮은 라, 남자 저음역대)
const MAX_NOTE = 74; // D5 (높은 레, 여자 고음역대)

// === Global Settings ===
window.micSensitivity = 5.0; // 최상단(최대치) 고정

// === Game State ===
let gameState = 'START'; // 'START', 'PRACTICE', 'CAVE', 'GAMEOVER'
let lastMode = 'PRACTICE';
let score = 0;
let frameCount = 0;
let animationId;
let particles = [];
let lastPitchUpdateTime = 0;
let currentVisualPitch = -1;

// === Entities ===
const airplane = {
    x: 150,
    y: 300,
    width: 50,
    height: 30,
    velocity: 0,
    gravity: 0.18, 
    lift: -0.45,   
    maxFallSpeed: 5,   // 하강 최대 속도 제한
    maxRiseSpeed: -5   // 상승 최대 속도 제한
};

let obstacles = [];
const baseObstacleSpeed = 2.5;

// === Game Logic Functions ===

function resetGame() {
    airplane.y = canvas.height / 2;
    airplane.velocity = 0;
    obstacles = [];
    particles = [];
    score = 0;
    frameCount = 0;
    lastPitchUpdateTime = Date.now();
    currentVisualPitch = -1;
    scoreEl.innerText = score;
}

function spawnObstacle() {
    const minHeight = 100;
    const maxHeight = canvas.height - 100; // 천장에 닿지 않도록 공간 보장
    const mountainHeight = Math.random() * (maxHeight - minHeight) + minHeight;
    const mWidth = Math.random() * 200 + 150; // 150 ~ 350 랜덤 폭

    obstacles.push({
        x: canvas.width,
        mountainWidth: mWidth,
        mountainHeight: mountainHeight,
        passed: false
    });
}

function createParticles(x, y, count = 15) {
    for (let i = 0; i < count; i++) {
        particles.push({
            x: x,
            y: y,
            vx: (Math.random() - 0.5) * 8,
            vy: (Math.random() - 0.5) * 8,
            life: 1,
            decay: 0.02 + Math.random() * 0.03,
            color: Math.random() > 0.5 ? '#00f2fe' : '#4facfe'
        });
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) {
            particles.splice(i, 1);
        }
    }
}

function update() {
    const audioData = window.audioManager.getPitch();
    const pitch = audioData.pitch; // 즉각적으로 피치 읽어오기

    if (pitch > -1) {
        let note = noteFromPitch(pitch);
        document.getElementById('note-display').innerText = getNoteName(note);

        // 낮은 라(MIN_NOTE)부터 높은 레(MAX_NOTE) 매핑
        let mapped = (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
        mapped = Math.max(0, Math.min(1, mapped));
        volBar.style.width = `${mapped * 100}%`;

        // 피치에 기반한 목표 높이 (놓은 음일수록 위로)
        let targetY = canvas.height - (mapped * canvas.height);
        targetY = Math.min(canvas.height - airplane.height, Math.max(0, targetY));

        // 민첩하고 즉각적으로 목표 높이를 향해 가속 (반응속도 대폭 상승)
        airplane.velocity += ((targetY - airplane.y) * 0.2 - airplane.velocity) * 0.5;
        
        if (frameCount % 3 === 0) {
            particles.push({
                x: airplane.x,
                y: airplane.y + airplane.height / 2,
                vx: -2 - Math.random() * 2,
                vy: (Math.random() - 0.5) * 2,
                life: 1,
                decay: 0.05,
                color: '#00f2fe'
            });
        }
    } else {
        // 소리가 없으면 곧바로 떨어짐
        document.getElementById('note-display').innerText = '-';
        volBar.style.width = `0%`;
        airplane.velocity += (airplane.maxFallSpeed - airplane.velocity) * 0.2;
    }

    // 속도 제한 (순간적인 텔레포트 및 튕김 완벽 차단)
    if (airplane.velocity > airplane.maxFallSpeed) airplane.velocity = airplane.maxFallSpeed;
    if (airplane.velocity < airplane.maxRiseSpeed) airplane.velocity = airplane.maxRiseSpeed;

    updateParticles();
    airplane.y += airplane.velocity;

    // 천장, 바닥 충돌 처리
    if (airplane.y + airplane.height > canvas.height) {
        airplane.y = canvas.height - airplane.height;
        airplane.velocity = 0;
        if (gameState === 'CAVE') gameOver();
    }
    if (airplane.y < 0) {
        airplane.y = 0;
        airplane.velocity = 0;
        // 천장에 닿아도 죽지 않음!
    }

    // === 장애물 로직 (동굴 모드) ===
    if (gameState === 'CAVE') {
        const currentSpeed = baseObstacleSpeed + (score * 0.02); // 갈수록 증가하는 속도 폭 하향

        if (frameCount % 140 === 0) { // 장애물 등장 주기 증가 (서로 간격 멀게 변경)
            spawnObstacle();
        }

        for (let i = obstacles.length - 1; i >= 0; i--) {
            let obs = obstacles[i];
            obs.x -= currentSpeed;

            // 정밀한 산(삼각형) 충돌 감지
            let hitMountain = false;
            let planeCenterX = airplane.x + airplane.width / 2;
            let planeBottomY = airplane.y + airplane.height - 5; // margin 5

            if (planeCenterX > obs.x && planeCenterX < obs.x + obs.mountainWidth) {
                let mountainCurrentHeight = 0;
                if (planeCenterX < obs.x + obs.mountainWidth / 2) {
                    // 왼쪽 비탈
                    let ratio = (planeCenterX - obs.x) / (obs.mountainWidth / 2);
                    mountainCurrentHeight = obs.mountainHeight * ratio;
                } else {
                    // 오른쪽 비탈
                    let ratio = (obs.x + obs.mountainWidth - planeCenterX) / (obs.mountainWidth / 2);
                    mountainCurrentHeight = obs.mountainHeight * ratio;
                }
                
                if (planeBottomY > canvas.height - mountainCurrentHeight) {
                    hitMountain = true;
                }
            }

            if (hitMountain) {
                gameOver();
            }

            // 점수 증가 로직
            if (obs.x + obs.mountainWidth < airplane.x && !obs.passed) {
                score++;
                scoreEl.innerText = score;
                obs.passed = true;
                // 장애물 통과 시 점수 이펙트용 파티클
                createParticles(airplane.x + airplane.width, airplane.y, 10);
            }

            // 화면을 벗어나면 삭제
            if (obs.x + obs.mountainWidth < 0) {
                obstacles.splice(i, 1);
            }
        }
    } else if (gameState === 'PRACTICE') {
        // 연습 게임: 시간 기반 점수
        if (frameCount % 60 === 0) {
            score++;
            scoreEl.innerText = score;
        }
    }

    frameCount++;
}

// === Draw Functions ===

function drawGrid() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const speed = gameState === 'CAVE' ? baseObstacleSpeed : 2;
    const offset = frameCount * speed;
    
    ctx.beginPath();
    for (let x = 0; x <= canvas.width + 40; x += 40) {
        let posX = x - (offset % 40);
        ctx.moveTo(posX, 0);
        ctx.lineTo(posX, canvas.height);
    }
    ctx.stroke();
}

function drawPitchLines() {
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.font = 'bold 16px Pretendard, sans-serif';

    // 화면 전체에 대해 옥타브별 온음계(도레미파솔라시)를 배경선으로 표시
    for (let note = MIN_NOTE; note <= MAX_NOTE; note++) {
        let noteType = note % 12;
        let isWholeNote = [0, 2, 4, 5, 7, 9, 11].includes(noteType);
        
        if (isWholeNote) {
            let mapped = (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
            let y = canvas.height - (mapped * canvas.height);
            let isDo = (noteType === 0);
            
            ctx.strokeStyle = isDo ? 'rgba(0, 242, 254, 0.3)' : 'rgba(255, 255, 255, 0.08)';
            if (isDo) ctx.setLineDash([10, 5]); // '도' 라인은 점선 효과로 눈에 잘 띄게
            else ctx.setLineDash([]);
            
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
            ctx.setLineDash([]); // 복구

            // 화면 우측 끝에 음계 이름 그리기
            let name = getNoteName(note); 
            ctx.fillStyle = isDo ? 'rgba(0, 242, 254, 0.8)' : 'rgba(255, 255, 255, 0.3)';
            ctx.fillText(name, canvas.width - 20, y - 5);
        }
    }
}

function drawParticles() {
    for (let p of particles) {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.random() * 3 + 2, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1.0;
}

function drawAirplane() {
    ctx.save();
    
    // 기울기 시각 효과 (최대 30도까지만 기울어져 뒤집히지 않음)
    ctx.translate(airplane.x + airplane.width/2, airplane.y + airplane.height/2);
    let targetAngle = airplane.velocity * 5;
    if (targetAngle > 30) targetAngle = 30;
    if (targetAngle < -30) targetAngle = -30;
    ctx.rotate(targetAngle * Math.PI / 180);
    ctx.translate(-(airplane.x + airplane.width/2), -(airplane.y + airplane.height/2));

    // 몸체
    ctx.fillStyle = '#ffb703';
    ctx.beginPath();
    ctx.roundRect(airplane.x, airplane.y + 5, airplane.width, 20, 10);
    ctx.fill();

    // 꼬리 날개
    ctx.fillStyle = '#fb8500';
    ctx.beginPath();
    ctx.moveTo(airplane.x + 5, airplane.y + 15);
    ctx.lineTo(airplane.x - 5, airplane.y - 5);
    ctx.lineTo(airplane.x + 15, airplane.y + 5);
    ctx.fill();

    // 메인 날개
    ctx.fillStyle = '#00f2fe';
    ctx.beginPath();
    ctx.moveTo(airplane.x + 15, airplane.y + 20);
    ctx.lineTo(airplane.x + 25, airplane.y + 35);
    ctx.lineTo(airplane.x + 40, airplane.y + 20);
    ctx.fill();

    // 창문
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(airplane.x + 35, airplane.y + 12, 4, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
}

function drawObstacles() {
    for (let obs of obstacles) {
        // 산 몸체 그리기 (아래에서 위로 그라데이션)
        const gradientTop = ctx.createLinearGradient(0, canvas.height - obs.mountainHeight, 0, canvas.height);
        gradientTop.addColorStop(0, '#475569');
        gradientTop.addColorStop(1, '#0f172a');

        ctx.fillStyle = gradientTop;
        ctx.strokeStyle = '#00f2fe';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.moveTo(obs.x, canvas.height);
        ctx.lineTo(obs.x + obs.mountainWidth / 2, canvas.height - obs.mountainHeight);
        ctx.lineTo(obs.x + obs.mountainWidth, canvas.height);
        ctx.fill();
        
        // 산봉우리 눈 덮인 효과
        ctx.beginPath();
        let snowRatio = 0.3; // 상단 30% 눈 덮임
        let snowHeight = obs.mountainHeight * snowRatio;
        let leftX = obs.x + (obs.mountainWidth / 2) * (1 - snowRatio);
        let rightX = obs.x + obs.mountainWidth / 2 + (obs.mountainWidth / 2) * snowRatio;
        
        ctx.moveTo(leftX, canvas.height - obs.mountainHeight + snowHeight);
        ctx.lineTo(obs.x + obs.mountainWidth / 2, canvas.height - obs.mountainHeight);
        ctx.lineTo(rightX, canvas.height - obs.mountainHeight + snowHeight);
        ctx.lineTo(obs.x + obs.mountainWidth / 2, canvas.height - obs.mountainHeight + snowHeight + 10); // 조금 불규칙하게
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();

        // 산 테두리
        ctx.beginPath();
        ctx.moveTo(obs.x, canvas.height);
        ctx.lineTo(obs.x + obs.mountainWidth / 2, canvas.height - obs.mountainHeight);
        ctx.lineTo(obs.x + obs.mountainWidth, canvas.height);
        ctx.stroke();
    }
}

function draw() {
    // 배경 클리어
    const bgGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bgGradient.addColorStop(0, '#0f172a');
    bgGradient.addColorStop(1, '#1e1b4b');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawPitchLines();

    // 모드에 따라 렌더링
    if (gameState === 'CAVE') {
        drawObstacles();
    }

    drawParticles();
    drawAirplane();
}

function gameLoop() {
    if (gameState === 'PRACTICE' || gameState === 'CAVE') {
        update();
        draw();
        animationId = requestAnimationFrame(gameLoop);
    }
}

// === Flow Control ===

function startGame(mode) {
    window.audioManager.init().then(success => {
        if (success) {
            window.audioManager.resumeContext();
            
            lastMode = mode;
            gameState = mode;
            resetGame();
            
            startScreen.classList.remove('active');
            gameoverScreen.classList.remove('active');
            hud.classList.remove('hidden');
            
            gameLoop();
        }
    });
}

function gameOver() {
    gameState = 'GAMEOVER';
    cancelAnimationFrame(animationId);
    
    // 폭발 이펙트 생성 및 그리기
    createParticles(airplane.x + airplane.width/2, airplane.y + airplane.height/2, 30);
    drawParticles(); // 한 프레임 그려주기
    
    finalScoreEl.innerText = score;
    hud.classList.add('hidden');
    gameoverScreen.classList.add('active');
}

// === Events ===
btnPractice.addEventListener('click', () => startGame('PRACTICE'));
btnCave.addEventListener('click', () => startGame('CAVE'));
btnRetry.addEventListener('click', () => startGame(lastMode));
btnMenu.addEventListener('click', () => {
    gameoverScreen.classList.remove('active');
    startScreen.classList.add('active');
    gameState = 'START';
});

btnBack.addEventListener('click', () => {
    gameState = 'START';
    cancelAnimationFrame(animationId);
    hud.classList.add('hidden');
    startScreen.classList.add('active');
});
