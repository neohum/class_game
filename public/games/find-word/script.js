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

const btnCheckWord = document.getElementById('btn-check-word');
const btnClearSelection = document.getElementById('btn-clear-selection');

const pauseOverlay = document.getElementById('pause-overlay');
const completeOverlay = document.getElementById('complete-overlay');
const btnCompleteBackMenu = document.getElementById('btn-complete-back-menu');

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
    if (completeOverlay) completeOverlay.classList.add('hidden');
}

btnBackMenu.addEventListener('click', showMenu);
btnPauseBackMenu.addEventListener('click', showMenu);
if (btnCompleteBackMenu) btnCompleteBackMenu.addEventListener('click', showMenu);

if (btnClearSelection) btnClearSelection.addEventListener('click', clearSelection);
if (btnCheckWord) btnCheckWord.addEventListener('click', checkWordValidity);

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

function clearSelection() {
    selectedIndices.forEach(idx => {
        const el = boardEl.children[idx];
        if (el) {
            el.classList.remove('active');
            el.classList.remove('error');
        }
    });
    selectedIndices = [];
    updateSelectionDisplay();
}

function handleCellClick(index) {
    if (isPaused) return;
    
    const cellEl = boardEl.children[index];
    if (cellEl.classList.contains('found')) return;

    if (selectedIndices.includes(index)) {
        if (selectedIndices[selectedIndices.length - 1] === index) {
            selectedIndices.pop();
            cellEl.classList.remove('active');
            updateSelectionDisplay();
        }
        return;
    }

    selectedIndices.push(index);
    cellEl.classList.add('active');
    updateSelectionDisplay();
}

async function checkWordValidity() {
    if (selectedIndices.length < 1) return;
    if (isPaused) return;
    
    const sequenceStr = selectedIndices.map(idx => gridLetters[idx]).join('');
    
    btnCheckWord.innerText = '검색 중...';
    btnCheckWord.disabled = true;
    
    try {
        const localMatch = dictionary.find(item => item.word === sequenceStr);
        if (localMatch) {
            handleWordFound(localMatch);
            resetCheckBtn();
            return;
        }

        const encodedWord = encodeURIComponent(sequenceStr);
        let foundMeaning = null;
        let isValid = false;

        // 1. Try Wikipedia REST API for high-quality rich text extract
        try {
            const wikiUrl = `https://ko.wikipedia.org/api/rest_v1/page/summary/${encodedWord}`;
            const wikiRes = await fetch(wikiUrl);
            if (wikiRes.status === 200) {
                const wikiData = await wikiRes.json();
                if (wikiData.extract && wikiData.extract.length > 5 && !wikiData.extract.includes("may refer to")) {
                    foundMeaning = wikiData.extract.substring(0, 150);
                    isValid = true;
                }
            }
        } catch(wikiErr) {
            console.log("Wikipedia missed, falling back to Wiktionary");
        }

        // 2. Fallback to Wiktionary OpenSearch (Verifies word existence even if extract fails)
        if (!isValid) {
            const dictUrl = `https://ko.wiktionary.org/w/api.php?action=opensearch&search=${encodedWord}&limit=1&format=json&origin=*`;
            const dictRes = await fetch(dictUrl);
            const dictData = await dictRes.json();
            
            if (dictData && dictData[1] && dictData[1].length > 0 && dictData[1][0] === sequenceStr) {
                isValid = true;
                foundMeaning = "국어사전에 등재된 유효한 한국어 단어입니다.";
            }
        }
        
        resetCheckBtn();

        if (isValid) {
            handleWordFound({ word: sequenceStr, meaning: foundMeaning + " (오픈백과)" });
        } else {
            showError();
        }

    } catch (e) {
        console.error("API Error", e);
        resetCheckBtn();
        showError();
    }
}

function resetCheckBtn() {
    btnCheckWord.innerText = '정답 확인';
    btnCheckWord.disabled = false;
}

function showError() {
    selectedIndices.forEach(idx => {
        const el = boardEl.children[idx];
        if (el) el.classList.add('error');
    });

    setTimeout(() => {
        clearSelection();
    }, 400);
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
    
    // Evaluate if game is complete after animation finishes
    setTimeout(checkGameComplete, 550);
}

function checkGameComplete() {
    const remainingChars = [];
    for (let i = 0; i < gridLetters.length; i++) {
        const el = boardEl.children[i];
        if (!el.classList.contains('found')) {
            remainingChars.push(gridLetters[i]);
        }
    }

    if (remainingChars.length === 0) {
        completeOverlay.classList.remove('hidden');
        return;
    }

    const remainFreq = {};
    for (let char of remainingChars) {
        remainFreq[char] = (remainFreq[char] || 0) + 1;
    }

    // Check if ANY base dictionary word can still be formed
    for (let i = 0; i < dictionary.length; i++) {
        const word = dictionary[i].word;
        if (!word) continue;

        const wordFreq = {};
        for (let char of word) {
            wordFreq[char] = (wordFreq[char] || 0) + 1;
        }

        let canForm = true;
        for (let char in wordFreq) {
            if (!remainFreq[char] || remainFreq[char] < wordFreq[char]) {
                canForm = false;
                break;
            }
        }

        if (canForm) {
            return; // Game not complete, valid subset exists
        }
    }

    // Completely exhausted
    completeOverlay.classList.remove('hidden');
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
