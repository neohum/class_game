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

const btnMountain = document.getElementById('btn-mountain');
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

// === Game State ===
let gameState = 'START'; 
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
    maxFallSpeed: 5,   
    maxRiseSpeed: -5   
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
    obstacles.push(new MountainObstacle(canvas.width, canvas.height));
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
    const pitch = audioData.pitch; 

    if (pitch > -1) {
        let note = noteFromPitch(pitch);
        document.getElementById('note-display').innerText = getNoteName(note);

        let mapped = (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
        mapped = Math.max(0, Math.min(1, mapped));
        volBar.style.width = `${mapped * 100}%`;

        let targetY = canvas.height - (mapped * canvas.height);
        targetY = Math.min(canvas.height - airplane.height, Math.max(0, targetY));

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
        document.getElementById('note-display').innerText = '-';
        volBar.style.width = `0%`;
        airplane.velocity += (airplane.maxFallSpeed - airplane.velocity) * 0.2;
    }

    if (airplane.velocity > airplane.maxFallSpeed) airplane.velocity = airplane.maxFallSpeed;
    if (airplane.velocity < airplane.maxRiseSpeed) airplane.velocity = airplane.maxRiseSpeed;

    updateParticles();
    airplane.y += airplane.velocity;

    if (airplane.y + airplane.height > canvas.height) {
        airplane.y = canvas.height - airplane.height;
        airplane.velocity = 0;
        gameOver();
    }
    if (airplane.y < 0) {
        airplane.y = 0;
        airplane.velocity = 0;
    }

    const currentSpeed = baseObstacleSpeed + (score * 0.02); 

    if (frameCount % 140 === 0) { 
        spawnObstacle();
    }

    for (let i = obstacles.length - 1; i >= 0; i--) {
        let obs = obstacles[i];
        obs.update(currentSpeed);

        let planeCenterX = airplane.x + airplane.width / 2;
        let planeBottomY = airplane.y + airplane.height - 5; 
        let planeTopY = airplane.y + 5; 
        let planeLeftX = airplane.x + 5;
        let planeRightX = airplane.x + airplane.width - 5;

        let hitObstacle = obs.checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX, canvas.height);

        if (hitObstacle) {
            gameOver();
        }

        if (obs.x + obs.width < airplane.x && !obs.passed) {
            score++;
            scoreEl.innerText = score;
            obs.passed = true;
            createParticles(airplane.x + airplane.width, airplane.y, 10);
        }

        if (obs.x + obs.width < 0) {
            obstacles.splice(i, 1);
        }
    }

    frameCount++;
}

// === Draw Functions ===

function drawGrid() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const speed = baseObstacleSpeed;
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

    for (let note = MIN_NOTE; note <= MAX_NOTE; note++) {
        let noteType = note % 12;
        let isWholeNote = [0, 2, 4, 5, 7, 9, 11].includes(noteType);
        
        if (isWholeNote) {
            let mapped = (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
            let y = canvas.height - (mapped * canvas.height);
            let isDo = (noteType === 0);
            
            ctx.strokeStyle = isDo ? 'rgba(0, 242, 254, 0.3)' : 'rgba(255, 255, 255, 0.08)';
            if (isDo) ctx.setLineDash([10, 5]); 
            else ctx.setLineDash([]);
            
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
            ctx.setLineDash([]); 

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
    
    ctx.translate(airplane.x + airplane.width/2, airplane.y + airplane.height/2);
    let targetAngle = airplane.velocity * 5;
    if (targetAngle > 30) targetAngle = 30;
    if (targetAngle < -30) targetAngle = -30;
    ctx.rotate(targetAngle * Math.PI / 180);
    ctx.translate(-(airplane.x + airplane.width/2), -(airplane.y + airplane.height/2));

    ctx.fillStyle = '#ffb703';
    ctx.beginPath();
    ctx.roundRect(airplane.x, airplane.y + 5, airplane.width, 20, 10);
    ctx.fill();

    ctx.fillStyle = '#fb8500';
    ctx.beginPath();
    ctx.moveTo(airplane.x + 5, airplane.y + 15);
    ctx.lineTo(airplane.x - 5, airplane.y - 5);
    ctx.lineTo(airplane.x + 15, airplane.y + 5);
    ctx.fill();

    ctx.fillStyle = '#00f2fe';
    ctx.beginPath();
    ctx.moveTo(airplane.x + 15, airplane.y + 20);
    ctx.lineTo(airplane.x + 25, airplane.y + 35);
    ctx.lineTo(airplane.x + 40, airplane.y + 20);
    ctx.fill();

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
    const bgGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bgGradient.addColorStop(0, '#0f172a');
    bgGradient.addColorStop(1, '#1e1b4b');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawPitchLines();
    drawObstacles();
    drawParticles();
    drawAirplane();
}

function gameLoop() {
    if (gameState === 'PLAYING') {
        update();
        draw();
        animationId = requestAnimationFrame(gameLoop);
    }
}

// === Flow Control ===

function startGame() {
    window.audioManager.init().then(success => {
        if (success) {
            window.audioManager.resumeContext();
            
            gameState = 'PLAYING';
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
    
    createParticles(airplane.x + airplane.width/2, airplane.y + airplane.height/2, 30);
    drawParticles(); 
    
    finalScoreEl.innerText = score;
    hud.classList.add('hidden');
    gameoverScreen.classList.add('active');
}

// === Events ===
btnMountain?.addEventListener('click', () => startGame());
btnRetry?.addEventListener('click', () => startGame());
btnMenu?.addEventListener('click', () => {
    window.location.href = 'index.html';
});

btnBack?.addEventListener('click', () => {
    window.location.href = 'index.html';
});

window.addEventListener('load', () => {
    // Navigate from index triggers this, so auto-start
    startGame();
});
