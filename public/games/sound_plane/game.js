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
const btnMountain = document.getElementById('btn-mountain');
const btnCave = document.getElementById('btn-cave');
const btnSky = document.getElementById('btn-sky');
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

// === Classes ===
class MountainObstacle {
    constructor(canvasWidth, canvasHeight) {
        this.type = 'mountain';
        this.x = canvasWidth;
        this.mountainWidth = Math.random() * 200 + 150;
        
        const minH = canvasHeight * 0.1; // 최소 높이 10%
        const maxH = canvasHeight * 0.75; // 최대 높이 75%
        
        // 이전 산과 차이를 눈에 띄게 주기 위해 높이를 더 크게 무작위화
        const randomFactor = Math.random();
        if (randomFactor < 0.3) {
            this.bottomMountainHeight = minH + Math.random() * (canvasHeight * 0.15); // 낮은 산
        } else if (randomFactor < 0.7) {
            this.bottomMountainHeight = canvasHeight * 0.35 + Math.random() * (canvasHeight * 0.15); // 중간 산
        } else {
            this.bottomMountainHeight = maxH - Math.random() * (canvasHeight * 0.15); // 높은 산
        }
        
        this.topMountainHeight = 0; 
        
        this.passed = false;
        this.width = this.mountainWidth; // For generic scoring logic
    }

    update(speed) {
        this.x -= speed;
    }

    checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX, canvasHeight) {
        if (planeCenterX > this.x && planeCenterX < this.x + this.mountainWidth) {
            let bottomCurrentHeight = 0;
            
            if (planeCenterX < this.x + this.mountainWidth / 2) {
                let ratio = (planeCenterX - this.x) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
            } else {
                let ratio = (this.x + this.mountainWidth - planeCenterX) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
            }
            
            if (planeBottomY > canvasHeight - bottomCurrentHeight) {
                return true; 
            }
        }
        return false;
    }

    draw(ctx, canvasHeight) {
        let snowRatio = 0.3; 
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00f2fe';

        const gradientBottom = ctx.createLinearGradient(0, canvasHeight - this.bottomMountainHeight, 0, canvasHeight);
        gradientBottom.addColorStop(0, '#475569');
        gradientBottom.addColorStop(1, '#0f172a');

        ctx.fillStyle = gradientBottom;
        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.fill();
        
        ctx.beginPath();
        let snowHeightB = this.bottomMountainHeight * snowRatio;
        let leftXB = this.x + (this.mountainWidth / 2) * (1 - snowRatio);
        let rightXB = this.x + this.mountainWidth / 2 + (this.mountainWidth / 2) * snowRatio;
        
        ctx.moveTo(leftXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(rightXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight + snowHeightB + 10);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.stroke();
    }
}

class CaveObstacle {
    constructor(canvasWidth, canvasHeight) {
        this.type = 'cave';
        this.x = canvasWidth;
        this.mountainWidth = Math.random() * 200 + 150;
        
        const minHeight = 50;
        const gap = Math.random() * 150 + 200; 
        const maxAvailableHeight = canvasHeight - gap;
        
        if (maxAvailableHeight > minHeight * 2) {
            this.topMountainHeight = Math.random() * (maxAvailableHeight - minHeight * 2) + minHeight;
            this.bottomMountainHeight = maxAvailableHeight - this.topMountainHeight;
        } else {
            this.topMountainHeight = minHeight;
            this.bottomMountainHeight = minHeight;
        }
        
        this.passed = false;
        this.width = this.mountainWidth; // For generic scoring logic
    }

    update(speed) {
        this.x -= speed;
    }

    checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX, canvasHeight) {
        if (planeCenterX > this.x && planeCenterX < this.x + this.mountainWidth) {
            let bottomCurrentHeight = 0;
            let topCurrentHeight = 0;
            
            if (planeCenterX < this.x + this.mountainWidth / 2) {
                let ratio = (planeCenterX - this.x) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
                topCurrentHeight = this.topMountainHeight * ratio;
            } else {
                let ratio = (this.x + this.mountainWidth - planeCenterX) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
                topCurrentHeight = this.topMountainHeight * ratio;
            }
            
            if (planeBottomY > canvasHeight - bottomCurrentHeight) {
                return true; 
            }
            if (topCurrentHeight > 0 && planeTopY < topCurrentHeight) {
                return true; 
            }
        }
        return false;
    }

    draw(ctx, canvasHeight) {
        let snowRatio = 0.3; 
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00f2fe';

        // Bottom Mountain
        const gradientBottom = ctx.createLinearGradient(0, canvasHeight - this.bottomMountainHeight, 0, canvasHeight);
        gradientBottom.addColorStop(0, '#475569');
        gradientBottom.addColorStop(1, '#0f172a');

        ctx.fillStyle = gradientBottom;
        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.fill();
        
        ctx.beginPath();
        let snowHeightB = this.bottomMountainHeight * snowRatio;
        let leftXB = this.x + (this.mountainWidth / 2) * (1 - snowRatio);
        let rightXB = this.x + this.mountainWidth / 2 + (this.mountainWidth / 2) * snowRatio;
        
        ctx.moveTo(leftXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(rightXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight + snowHeightB + 10);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.stroke();

        // Top Mountain
        if (this.topMountainHeight > 0) {
            const gradientTop = ctx.createLinearGradient(0, 0, 0, this.topMountainHeight);
            gradientTop.addColorStop(0, '#0f172a');
            gradientTop.addColorStop(1, '#475569');

            ctx.fillStyle = gradientTop;
            ctx.beginPath();
            ctx.moveTo(this.x, 0);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight);
            ctx.lineTo(this.x + this.mountainWidth, 0);
            ctx.fill();
            
            ctx.beginPath();
            let snowHeightT = this.topMountainHeight * snowRatio;
            let leftXT = this.x + (this.mountainWidth / 2) * (1 - snowRatio);
            let rightXT = this.x + this.mountainWidth / 2 + (this.mountainWidth / 2) * snowRatio;
            
            ctx.moveTo(leftXT, this.topMountainHeight - snowHeightT);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight);
            ctx.lineTo(rightXT, this.topMountainHeight - snowHeightT);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight - snowHeightT - 10);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(this.x, 0);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight);
            ctx.lineTo(this.x + this.mountainWidth, 0);
            ctx.stroke();
        }
    }
}

class SkyObstacle {
    constructor(canvasWidth, canvasHeight) {
        this.type = 'cloud';
        this.width = Math.random() * 80 + 120;
        this.height = Math.random() * 60 + 60;
        this.x = canvasWidth;
        this.y = Math.random() * (canvasHeight - this.height - 40) + 20;
        this.passed = false;
    }

    update(speed) {
        this.x -= speed;
    }

    checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX) {
        let cLeft = this.x + 10;
        let cRight = this.x + this.width - 10;
        let cTop = this.y + 10;
        let cBottom = this.y + this.height - 10;

        if (planeRightX > cLeft && planeLeftX < cRight &&
            planeBottomY > cTop && planeTopY < cBottom) {
            return true;
        }
        return false;
    }

    draw(ctx) {
        ctx.fillStyle = 'rgba(71, 85, 105, 0.85)';
        ctx.beginPath();
        ctx.arc(this.x + this.width * 0.3, this.y + this.height * 0.5, this.height * 0.4, 0, Math.PI * 2);
        ctx.arc(this.x + this.width * 0.7, this.y + this.height * 0.5, this.height * 0.4, 0, Math.PI * 2);
        ctx.arc(this.x + this.width * 0.5, this.y + this.height * 0.3, this.height * 0.5, 0, Math.PI * 2);
        ctx.arc(this.x + this.width * 0.5, this.y + this.height * 0.7, this.height * 0.3, 0, Math.PI * 2);
        ctx.fill();
        
        if (Math.random() < 0.1) {
            ctx.strokeStyle = '#facc15';
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(this.x + this.width / 2, this.y + this.height * 0.8);
            ctx.lineTo(this.x + this.width / 2 - 10, this.y + this.height * 0.8 + 15);
            ctx.lineTo(this.x + this.width / 2 + 5, this.y + this.height * 0.8 + 15);
            ctx.lineTo(this.x + this.width / 2 - 5, this.y + this.height * 0.8 + 35);
            ctx.stroke();
        }
    }
}

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
    if (gameState === 'SKY') {
        obstacles.push(new SkyObstacle(canvas.width, canvas.height));
    } else if (gameState === 'CAVE') {
        obstacles.push(new CaveObstacle(canvas.width, canvas.height));
    } else {
        // MOUNTAIN 로직
        obstacles.push(new MountainObstacle(canvas.width, canvas.height));
    }
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
        if (gameState === 'MOUNTAIN' || gameState === 'CAVE' || gameState === 'SKY') gameOver();
    }
    if (airplane.y < 0) {
        airplane.y = 0;
        airplane.velocity = 0;
        // 천장에 닿아도 죽지 않음!
    }

    // === 장애물 로직 ===
    if (gameState === 'MOUNTAIN' || gameState === 'CAVE' || gameState === 'SKY') {
        const currentSpeed = baseObstacleSpeed + (score * 0.02); // 갈수록 증가하는 속도 폭 하향

        if (frameCount % 140 === 0) { // 장애물 등장 주기
            spawnObstacle();
        }

        for (let i = obstacles.length - 1; i >= 0; i--) {
            let obs = obstacles[i];
            obs.update(currentSpeed);

            let planeCenterX = airplane.x + airplane.width / 2;
            let planeBottomY = airplane.y + airplane.height - 5; // margin 5
            let planeTopY = airplane.y + 5; // margin 5
            let planeLeftX = airplane.x + 5;
            let planeRightX = airplane.x + airplane.width - 5;

            let hitObstacle = obs.checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX, canvas.height);

            if (hitObstacle) {
                gameOver();
            }

            // 점수 증가 로직
            if (obs.x + obs.width < airplane.x && !obs.passed) {
                score++;
                scoreEl.innerText = score;
                obs.passed = true;
                // 장애물 통과 시 점수 이펙트용 파티클
                createParticles(airplane.x + airplane.width, airplane.y, 10);
            }

            // 화면을 벗어나면 삭제
            if (obs.x + obs.width < 0) {
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
    const speed = (gameState === 'MOUNTAIN' || gameState === 'CAVE' || gameState === 'SKY') ? baseObstacleSpeed : 2;
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
        if (obs.draw) {
            obs.draw(ctx, canvas.height);
        }
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
    if (gameState === 'MOUNTAIN' || gameState === 'CAVE' || gameState === 'SKY') {
        drawObstacles();
    }

    drawParticles();
    drawAirplane();
}

function gameLoop() {
    if (gameState === 'PRACTICE' || gameState === 'MOUNTAIN' || gameState === 'CAVE' || gameState === 'SKY') {
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
btnMountain.addEventListener('click', () => startGame('MOUNTAIN'));
btnCave.addEventListener('click', () => startGame('CAVE'));
btnSky.addEventListener('click', () => startGame('SKY'));
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
