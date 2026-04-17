let dictionary = [];
const fillerChars = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호기니디리미비시이지치키티피히구누두루무부수우주추쿠투푸후";

let gridLetters = [];
let isPaused = false;
let currentLevel = 1;
let currentCellsCount = 25;
let currentWordsCount = 3;

let selectedIndices = [];

// Load dynamic dictionary immediately
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('dictionary.json');
        dictionary = await res.json();
        console.log("Dictionary loaded:", dictionary.length, "words");
    } catch(e) {
        console.error("Failed to load dictionary.json. Please ensure it exists and server is running.", e);
        // Fallback dummy just in case
        dictionary = [{ word: "테스트", meaning: "사전 로드 실패용 단어" }];
    }
});


// DOM Elements
const menuScreen = document.getElementById('menu-screen');
const gameScreen = document.getElementById('game-screen');
const boardEl = document.getElementById('game-board');
const foundCountEl = document.getElementById('found-count');
const foundWordsListEl = document.getElementById('found-words-list');
const selectionDisplayEl = document.getElementById('current-selection-display');

const btnLevelSelects = document.querySelectorAll('.btn-level');
const btnPause = document.getElementById('btn-pause');
const btnNewGame = document.getElementById('btn-new-game');
const btnBackMenu = document.getElementById('btn-back-menu');
const btnPauseBackMenu = document.getElementById('btn-pause-back-menu');
const btnResume = document.getElementById('btn-resume');

const pauseOverlay = document.getElementById('pause-overlay');

// Stage definitions
const levelConfig = {
    1: { cells: 25, words: 3, gridClass: 'grid-5x5' },
    2: { cells: 49, words: 6, gridClass: 'grid-7x7' },
    3: { cells: 100, words: 12, gridClass: 'grid-10x10' }
};

// Start Level from Menu
btnLevelSelects.forEach(btn => {
    btn.addEventListener('click', (e) => {
        currentLevel = parseInt(e.target.dataset.level);
        startGame(currentLevel);
    });
});

// Go Back to Menu
function showMenu() {
    gameScreen.classList.add('hidden');
    menuScreen.classList.remove('hidden');
    isPaused = false;
    pauseOverlay.classList.add('hidden');
}

btnBackMenu.addEventListener('click', showMenu);
btnPauseBackMenu.addEventListener('click', showMenu);

function startGame(level) {
    const config = levelConfig[level];
    currentCellsCount = config.cells;
    currentWordsCount = config.words;

    // Toggle screens
    menuScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');

    // Update board class
    boardEl.className = `grid-container ${config.gridClass}`;

    initGame();
}

function initGame() {
    isPaused = false;
    selectedIndices = [];
    gridLetters = new Array(currentCellsCount).fill('');

    updatePauseUI();
    foundWordsListEl.innerHTML = '';
    foundCountEl.innerText = '0';
    updateSelectionDisplay();

    // Pick words to guarantee *some* words are hidden, but ANY word works now!
    const shuffledDict = [...dictionary].sort(() => 0.5 - Math.random());
    const hiddenWordsToSeed = shuffledDict.slice(0, currentWordsCount);

    let lettersToHide = [];
    hiddenWordsToSeed.forEach(item => {
        for (let char of item.word) {
            lettersToHide.push(char);
        }
    });

    let availableSlots = Array.from({length: currentCellsCount}, (_, i) => i);
    availableSlots.sort(() => 0.5 - Math.random());

    for (let char of lettersToHide) {
        if(availableSlots.length > 0) {
            let slot = availableSlots.pop();
            gridLetters[slot] = char;
        }
    }

    for (let i = 0; i < gridLetters.length; i++) {
        if (!gridLetters[i]) {
            const randomChar = fillerChars[Math.floor(Math.random() * fillerChars.length)];
            gridLetters[i] = randomChar;
        }
    }

    renderBoard();
}

function renderBoard() {
    boardEl.innerHTML = '';
    for (let i = 0; i < gridLetters.length; i++) {
        const cell = document.createElement('div');
        cell.classList.add('grid-cell');
        cell.dataset.index = i;
        cell.dataset.number = i + 1;
        cell.innerText = gridLetters[i];
        cell.addEventListener('click', () => handleCellClick(i));
        boardEl.appendChild(cell);
    }
}

function handleCellClick(index) {
    if (isPaused) return;
    
    const cellEl = boardEl.children[index];
    
    if (cellEl.classList.contains('found') || selectedIndices.includes(index)) return;

    const testIndices = [...selectedIndices, index];
    const sequenceStr = testIndices.map(idx => gridLetters[idx]).join('');

    // Important Rule Change: Check against EVERY word in dictionary, not just pre-seeded ones
    const isPrefixValid = dictionary.some(item => item.word && item.word.startsWith(sequenceStr));

    if (isPrefixValid) {
        selectedIndices.push(index);
        cellEl.classList.add('active');
        updateSelectionDisplay();

        const matchedWordObj = dictionary.find(item => item.word && item.word === sequenceStr);
        if (matchedWordObj) {
            handleWordFound(matchedWordObj);
        }
    } else {
        cellEl.classList.add('error');
        selectedIndices.forEach(idx => {
            boardEl.children[idx].classList.add('error');
        });

        setTimeout(() => {
            cellEl.classList.remove('error');
            selectedIndices.forEach(idx => {
                const el = boardEl.children[idx];
                if (el) {
                    el.classList.remove('error');
                    el.classList.remove('active');
                }
            });
            selectedIndices = [];
            updateSelectionDisplay();
        }, 400);
    }
}

function handleWordFound(wordObj) {
    selectedIndices.forEach(idx => {
        const el = boardEl.children[idx];
        el.classList.remove('active');
        el.classList.add('success');
        
        setTimeout(() => {
            el.classList.remove('success');
            el.classList.add('found');
        }, 500);
    });

    selectedIndices = [];
    updateSelectionDisplay();
    addWordToLog(wordObj);
}

function updateSelectionDisplay() {
    if (selectedIndices.length === 0) {
        selectionDisplayEl.innerHTML = '<span class="placeholder">글자를 클릭하세요</span>';
    } else {
        const str = selectedIndices.map(idx => gridLetters[idx]).join('');
        selectionDisplayEl.innerHTML = str;
    }
}

function addWordToLog(wordObj) {
    const card = document.createElement('div');
    card.classList.add('word-card');
    card.innerHTML = `
        <div class="word-title">${wordObj.word}</div>
        <div class="word-meaning">${wordObj.meaning}</div>
    `;
    foundWordsListEl.insertBefore(card, foundWordsListEl.firstChild);
    
    const currentFoundVal = parseInt(foundCountEl.innerText) || 0;
    foundCountEl.innerText = currentFoundVal + 1;
}

function togglePause() {
    isPaused = !isPaused;
    updatePauseUI();
}

function updatePauseUI() {
    if (isPaused) {
        pauseOverlay.classList.remove('hidden');
        btnPause.innerText = '계속하기';
    } else {
        pauseOverlay.classList.add('hidden');
        btnPause.innerText = '일시정지';
    }
}

btnPause.addEventListener('click', togglePause);
btnResume.addEventListener('click', () => {
    isPaused = false;
    updatePauseUI();
});
btnNewGame.addEventListener('click', initGame);
