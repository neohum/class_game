const itemsData = [
    { id: 'bone', emoji: '🦴', type: 'general' },
    { id: 'tissue', emoji: '🧻', type: 'general' },
    { id: 'water_bottle', emoji: '🧴', type: 'plastic' }, 
    { id: 'cup_with_straw', emoji: '🥤', type: 'plastic' }, 
    { id: 'coke_can', emoji: '🥫', type: 'can' }, 
    { id: 'box', emoji: '📦', type: 'paper' },
    { id: 'newspaper', emoji: '📰', type: 'paper' },
    { id: 'milk_carton', emoji: '🧃', type: 'paper' }, 
    { id: 'champagne', emoji: '🍾', type: 'glass' },
    { id: 'sake', emoji: '🍶', type: 'glass' },
];

const startScreen = document.getElementById('start-screen');
const boardsContainer = document.getElementById('boards-container');
const template = document.getElementById('player-board-template');

let totalPlayers = 1;
let activeBoards = [];

const changePlayersBtn = document.getElementById('change-players-btn');
if (changePlayersBtn) {
    changePlayersBtn.addEventListener('click', () => {
        location.reload();
    });
}

// 시작 버튼들 지연 없이 바로 인식
const startBtns = document.querySelectorAll('.start-btn');
startBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (!e.target.dataset.players) return;
        totalPlayers = parseInt(e.target.dataset.players);
        startGame();
    });
});

function startGame() {
    startScreen.classList.add('hidden');
    boardsContainer.innerHTML = '';
    activeBoards = [];
    
    const gameContainer = document.querySelector('.game-container');
    if (totalPlayers > 1) {
        gameContainer.classList.add('wide-mode');
    } else {
        gameContainer.classList.remove('wide-mode');
    }
    
    
    // 플레이어 수만큼 보드 생성
    for (let i = 0; i < totalPlayers; i++) {
        activeBoards.push(new PlayerBoard(i + 1, totalPlayers));
    }
}

class PlayerBoard {
    constructor(playerId, totalPlayers) {
        this.playerId = playerId;
        this.score = 0;
        this.remainingItems = 10;
        this.isCompleted = false;
        
        // 템플릿 복제하여 DOM 생성
        const clone = template.content.cloneNode(true);
        this.boardElement = clone.querySelector('.player-board');
        
        if (totalPlayers > 1) {
            this.boardElement.classList.add('multi'); // 다중 화면용 CSS 스케일 적용
        }
        
        this.nameElement = this.boardElement.querySelector('.player-name');
        this.scoreElement = this.boardElement.querySelector('.player-score');
        this.playArea = this.boardElement.querySelector('.board-play-area');
        this.bins = Array.from(this.boardElement.querySelectorAll('.bin'));
        this.completedOverlay = this.boardElement.querySelector('.board-completed-overlay');
        this.restartBtn = this.boardElement.querySelector('.board-restart-btn');
        
        this.nameElement.textContent = totalPlayers > 1 ? `플레이어 ${playerId}` : '내 점수';
        this.updateScore();
        
        this.restartBtn.addEventListener('click', () => this.restartBoard());
        
        boardsContainer.appendChild(this.boardElement);
        
        // DOM이 화면에 그려진 후 크기를 재기 위해 한 프레임 지연
        requestAnimationFrame(() => {
            this.startBoard();
        });
    }
    
    startBoard() {
        this.score = 0;
        this.remainingItems = 10;
        this.isCompleted = false;
        this.updateScore();
        this.playArea.innerHTML = ''; // 혹시 남아있는 쓰레기 청소
        this.completedOverlay.classList.add('hidden');
        
        for (let i = 0; i < this.remainingItems; i++) {
            this.spawnItem();
        }
    }
    
    restartBoard() {
        this.startBoard();
    }
    
    updateScore() {
        this.scoreElement.textContent = `점수: ${this.score}`;
    }
    
    spawnItem() {
        const itemData = itemsData[Math.floor(Math.random() * itemsData.length)];
        
        const itemElement = document.createElement('div');
        itemElement.classList.add('item');
        itemElement.textContent = itemData.emoji;
        itemElement.dataset.type = itemData.type;
        
        const areaRect = this.playArea.getBoundingClientRect();
        if (areaRect.width === 0) return;
        
        const margin = 30;
        // 가로는 마진을 뺀 전체 범위 내에서 무작위
        const randomX = margin + Math.random() * (areaRect.width - margin * 2);
        
        // 세로는 화면(놀이판)의 중심부(절반) 아래부터 바닥 마진 사이에서 무작위
        const centerY = areaRect.height / 2;
        const randomY = centerY + Math.random() * (centerY - margin);
        
        const randomRotation = Math.random() * 60 - 30;
        itemElement.style.setProperty('--rot', `${randomRotation}deg`);
        itemElement.style.left = `${randomX}px`;
        itemElement.style.top = `${randomY}px`;
        
        itemElement.dataset.initialX = randomX;
        itemElement.dataset.initialY = randomY;

        this.playArea.appendChild(itemElement);

        let isDragging = false;
        let startX, startY;
        let currentX, currentY;

        const dragStart = (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            
            isDragging = true;
            currentX = parseFloat(itemElement.style.left);
            currentY = parseFloat(itemElement.style.top);
            startX = e.clientX;
            startY = e.clientY;

            itemElement.style.zIndex = 100;
            itemElement.style.transition = 'none'; // 드래그 시 애니메이션 제거
            itemElement.setPointerCapture(e.pointerId);
            
            itemElement.addEventListener('pointermove', dragMove);
            itemElement.addEventListener('pointerup', dragEnd);
            itemElement.addEventListener('pointercancel', dragEnd);
        };

        const dragMove = (e) => {
            if (!isDragging) return;
            
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            itemElement.style.left = `${currentX + dx}px`;
            itemElement.style.top = `${currentY + dy}px`;
            
            const itemRect = itemElement.getBoundingClientRect();
            const itemCenterX = itemRect.left + itemRect.width / 2;
            const itemCenterY = itemRect.top + itemRect.height / 2;
            
            this.bins.forEach(bin => {
                const binRect = bin.getBoundingClientRect();
                if (
                    itemCenterX > binRect.left &&
                    itemCenterX < binRect.right &&
                    itemCenterY > binRect.top &&
                    itemCenterY < binRect.bottom
                ) {
                    bin.classList.add('highlight');
                } else {
                    bin.classList.remove('highlight');
                }
            });
        };

        const dragEnd = (e) => {
            if (!isDragging) return;
            isDragging = false;
            
            itemElement.removeEventListener('pointermove', dragMove);
            itemElement.removeEventListener('pointerup', dragEnd);
            itemElement.removeEventListener('pointercancel', dragEnd);

            itemElement.style.zIndex = 10;

            const itemRect = itemElement.getBoundingClientRect();
            const itemCenterX = itemRect.left + itemRect.width / 2;
            const itemCenterY = itemRect.top + itemRect.height / 2;

            let droppedBin = null;

            this.bins.forEach(bin => {
                bin.classList.remove('highlight');
                const binRect = bin.getBoundingClientRect();
                if (
                    itemCenterX > binRect.left &&
                    itemCenterX < binRect.right &&
                    itemCenterY > binRect.top &&
                    itemCenterY < binRect.bottom
                ) {
                    droppedBin = bin;
                }
            });

            if (droppedBin) {
                this.checkDrop(droppedBin, itemElement, itemData);
            } else {
                itemElement.style.left = `${itemElement.dataset.initialX}px`;
                itemElement.style.top = `${itemElement.dataset.initialY}px`;
            }
        };

        itemElement.addEventListener('pointerdown', dragStart);
    }
    
    checkDrop(bin, itemElement, itemData) {
        if (this.isCompleted) return;

        const binType = bin.dataset.type;
        const isCorrect = (binType === itemData.type);
        
        itemElement.style.pointerEvents = 'none'; // 애니메이션 도중 조작 방지
        
        // 휴지통 중심 좌표를 놀이판(playArea) 기준으로 계산하여 아이템 위치 이동
        const binRect = bin.getBoundingClientRect();
        const playAreaRect = this.playArea.getBoundingClientRect();
        
        const targetX = binRect.left + (binRect.width / 2) - playAreaRect.left;
        const targetY = binRect.top + (binRect.height / 2) - playAreaRect.top;
        
        itemElement.style.transition = 'left 0.2s, top 0.2s';
        itemElement.style.left = `${targetX}px`;
        itemElement.style.top = `${targetY}px`;
        itemElement.style.zIndex = 50;

        // O / X 마크 생성
        const mark = document.createElement('div');
        mark.classList.add('feedback-mark');
        mark.classList.add(isCorrect ? 'correct' : 'wrong');
        mark.textContent = isCorrect ? '⭕' : '❌';
        mark.style.left = `${targetX}px`;
        mark.style.top = `${targetY}px`;
        this.playArea.appendChild(mark);
        
        // 피드백 마크 삭제
        setTimeout(() => mark.remove(), 800);
        
        if (isCorrect) {
            this.playConfetti(bin);
            this.score += 10;
            this.updateScore();
            
            setTimeout(() => {
                itemElement.remove();
                this.remainingItems--;
                
                if (this.remainingItems === 0) {
                    this.isCompleted = true;
                    this.completedOverlay.classList.remove('hidden');
                }
            }, 400); 
        } else {
            this.score = Math.max(0, this.score - 5);
            this.updateScore();
            
            itemElement.classList.add('wrong-animation');
            setTimeout(() => {
                itemElement.style.transition = 'left 0.3s, top 0.3s, transform 0.1s';
                itemElement.classList.remove('wrong-animation');
                
                // 틀렸을 땐 제자리로 돌아가고 다시 드래그 가능하게
                itemElement.style.left = `${itemElement.dataset.initialX}px`;
                itemElement.style.top = `${itemElement.dataset.initialY}px`;
                
                setTimeout(() => {
                    itemElement.style.pointerEvents = 'auto';
                }, 300);
            }, 500);
        }
    }
    
    playConfetti(bin) {
        const binRect = bin.getBoundingClientRect();
        const x = (binRect.left + binRect.width / 2) / window.innerWidth;
        const y = binRect.top / window.innerHeight;

        confetti({
            particleCount: 50, // 화면이 분할되므로 파티클 수 약간 축소
            spread: 50,
            origin: { x: x, y: y },
            colors: ['#26ccff', '#a25afd', '#ff5e7e', '#88ff5a', '#fcff42', '#ffa62d', '#ff36ff'],
            zIndex: 100
        });
    }
}

// 우클릭 방지
document.addEventListener('contextmenu', event => event.preventDefault());
