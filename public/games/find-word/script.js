let dictionary = [];
const fillerChars = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호기니디리미비시이지치키티피히구누두루무부수우주추쿠투푸후";

let players = [];

// 우클릭 전역 방지
document.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('dictionary.json');
        dictionary = await res.json();
        console.log('Dictionary loaded:', dictionary.length, 'words');
    } catch (e) {
        console.error('Failed to load dictionary.json. Please ensure it exists and server is running.', e);
        dictionary = [{ word: '테스트', meaning: '사전 로드 실패용 단어' }];
    }
});

const menuScreen = document.getElementById('menu-screen');
const gameScreen = document.getElementById('game-screen');
const playersContainer = document.getElementById('players-container');
const playerTemplate = document.getElementById('player-template');
const btnBackMenu = document.getElementById('btn-back-menu');

const btnLevelSelects = document.querySelectorAll('.btn-level');

const levelConfig = {
    1: { cells: 16, words: 2, gridClass: 'grid-4x4' },
    2: { cells: 25, words: 3, gridClass: 'grid-5x5' },
    3: { cells: 49, words: 6, gridClass: 'grid-7x7' },
    4: { cells: 100, words: 12, gridClass: 'grid-10x10' }
};

btnLevelSelects.forEach(btn => {
    btn.addEventListener('click', e => {
        const level = parseInt(e.currentTarget.dataset.level, 10);
        const playerCount = parseInt(e.currentTarget.dataset.players, 10) || 1;
        startGame(level, playerCount);
    });
});

function showMenu() {
    gameScreen.classList.add('hidden');
    menuScreen.classList.remove('hidden');
    players.forEach(p => { p.isPaused = true; });
    playersContainer.innerHTML = '';
    players = [];
}

btnBackMenu.addEventListener('click', showMenu);

function startGame(level, playerCount) {
    menuScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    playersContainer.innerHTML = '';
    players = [];

    const config = levelConfig[level];

    for (let i = 0; i < playerCount; i++) {
        const clone = playerTemplate.content.cloneNode(true);
        const container = document.createElement('div');
        container.style.flex = "1";
        container.style.maxWidth = playerCount === 2 ? "50%" : "100%";
        container.appendChild(clone);
        playersContainer.appendChild(container);

        const player = new WordFindPlayer(container, config, i + 1);
        players.push(player);
        player.initGame();
    }
}

class WordFindPlayer {
    constructor(container, config, playerId) {
        this.container = container;
        this.config = config;
        this.playerId = playerId;
        
        this.gridLetters = [];
        this.isPaused = false;
        this.selectedIndices = [];
        this.currentCellsCount = config.cells;
        this.currentWordsCount = config.words;

        // UI Elements
        this.boardEl = container.querySelector('.game-board');
        this.foundCountEl = container.querySelector('.found-count');
        this.foundWordsListEl = container.querySelector('.found-words-list');
        this.selectionDisplayEl = container.querySelector('.current-selection-display');
        
        this.pauseOverlay = container.querySelector('.pause-overlay');
        this.completeOverlay = container.querySelector('.complete-overlay');
        
        this.btnPause = container.querySelector('.btn-pause');
        this.btnNewGame = container.querySelector('.btn-new-game');
        this.btnResume = container.querySelector('.btn-resume');
        this.btnCheckWord = container.querySelector('.btn-check-word');
        this.btnClearSelection = container.querySelector('.btn-clear-selection');
        this.btnCompleteRestart = container.querySelector('.btn-complete-restart');

        this.bindEvents();
    }

    bindEvents() {
        this.btnPause.addEventListener('click', () => this.togglePause());
        this.btnResume.addEventListener('click', () => {
            this.isPaused = false;
            this.updatePauseUI();
        });
        this.btnNewGame.addEventListener('click', () => this.initGame());
        this.btnCompleteRestart.addEventListener('click', () => this.initGame());
        this.btnClearSelection.addEventListener('click', () => this.clearSelection());
        this.btnCheckWord.addEventListener('click', () => this.checkWordValidity());
    }

    initGame() {
        this.isPaused = false;
        this.selectedIndices = [];
        this.gridLetters = new Array(this.currentCellsCount).fill('');

        this.updatePauseUI();
        this.completeOverlay.classList.add('hidden');
        
        this.foundWordsListEl.innerHTML = '';
        this.foundCountEl.innerText = '0';
        this.updateSelectionDisplay();

        this.boardEl.className = `game-board grid-container ${this.config.gridClass}`;
        this.boardEl.classList.toggle('hide-cell-numbers', this.config.cells === 16 || this.config.cells === 49 || this.config.cells >= 100);

        const shuffledDict = [...dictionary].sort(() => 0.5 - Math.random());
        const hiddenWordsToSeed = shuffledDict.slice(0, this.currentWordsCount);

        const lettersToHide = [];
        hiddenWordsToSeed.forEach(item => {
            for (const char of item.word) {
                lettersToHide.push(char);
            }
        });

        const availableSlots = Array.from({ length: this.currentCellsCount }, (_, i) => i);
        availableSlots.sort(() => 0.5 - Math.random());

        for (const char of lettersToHide) {
            if (availableSlots.length > 0) {
                const slot = availableSlots.pop();
                this.gridLetters[slot] = char;
            }
        }

        for (let i = 0; i < this.gridLetters.length; i += 1) {
            if (!this.gridLetters[i]) {
                const randomChar = fillerChars[Math.floor(Math.random() * fillerChars.length)];
                this.gridLetters[i] = randomChar;
            }
        }

        this.renderBoard();
    }

    renderBoard() {
        this.boardEl.innerHTML = '';
        for (let i = 0; i < this.gridLetters.length; i += 1) {
            const cell = document.createElement('div');
            cell.classList.add('grid-cell');
            cell.dataset.index = i;
            cell.dataset.number = i + 1;
            cell.innerText = this.gridLetters[i];
            cell.addEventListener('click', () => this.handleCellClick(i));
            this.boardEl.appendChild(cell);
        }
    }

    clearSelection() {
        this.selectedIndices.forEach(idx => {
            const el = this.boardEl.children[idx];
            if (el) {
                el.classList.remove('active');
                el.classList.remove('error');
            }
        });
        this.selectedIndices = [];
        this.updateSelectionDisplay();
    }

    handleCellClick(index) {
        if (this.isPaused) return;

        const cellEl = this.boardEl.children[index];
        if (cellEl.classList.contains('found')) return;

        if (this.selectedIndices.includes(index)) {
            if (this.selectedIndices[this.selectedIndices.length - 1] === index) {
                this.selectedIndices.pop();
                cellEl.classList.remove('active');
                this.updateSelectionDisplay();
            }
            return;
        }

        this.selectedIndices.push(index);
        cellEl.classList.add('active');
        this.updateSelectionDisplay();
    }

    async checkWordValidity() {
        if (this.selectedIndices.length < 1 || this.isPaused) return;

        const sequenceStr = this.selectedIndices.map(idx => this.gridLetters[idx]).join('');

        this.btnCheckWord.innerText = '검색 중...';
        this.btnCheckWord.disabled = true;

        try {
            const localMatch = dictionary.find(item => item.word === sequenceStr);
            if (localMatch) {
                this.handleWordFound(localMatch);
                this.resetCheckBtn();
                return;
            }

            const encodedWord = encodeURIComponent(sequenceStr);
            let foundMeaning = null;
            let isValid = false;

            try {
                const wikiUrl = `https://ko.wikipedia.org/api/rest_v1/page/summary/${encodedWord}`;
                const wikiRes = await fetch(wikiUrl);
                if (wikiRes.status === 200) {
                    const wikiData = await wikiRes.json();
                    if (wikiData.extract && wikiData.extract.length > 5 && !wikiData.extract.includes('may refer to')) {
                        foundMeaning = wikiData.extract.substring(0, 150);
                        isValid = true;
                    }
                }
            } catch (wikiErr) {
                console.log('Wikipedia missed, falling back to Wiktionary');
            }

            if (!isValid) {
                const dictUrl = `https://ko.wiktionary.org/w/api.php?action=opensearch&search=${encodedWord}&limit=1&format=json&origin=*`;
                const dictRes = await fetch(dictUrl);
                const dictData = await dictRes.json();

                if (dictData && dictData[1] && dictData[1].length > 0 && dictData[1][0] === sequenceStr) {
                    isValid = true;
                    foundMeaning = '국어사전에 등재된 유효한 한국어 단어입니다.';
                }
            }

            this.resetCheckBtn();

            if (isValid) {
                this.handleWordFound({ word: sequenceStr, meaning: `${foundMeaning} (오픈백과)` });
            } else {
                this.showError();
            }
        } catch (e) {
            console.error('API Error', e);
            this.resetCheckBtn();
            this.showError();
        }
    }

    resetCheckBtn() {
        this.btnCheckWord.innerText = '정답 확인';
        this.btnCheckWord.disabled = false;
    }

    showError() {
        this.selectedIndices.forEach(idx => {
            const el = this.boardEl.children[idx];
            if (el) {
                el.classList.add('error');
            }
        });

        setTimeout(() => {
            this.clearSelection();
        }, 400);
    }

    handleWordFound(wordObj) {
        this.selectedIndices.forEach(idx => {
            const el = this.boardEl.children[idx];
            el.classList.remove('active');
            el.classList.add('success');

            setTimeout(() => {
                el.classList.remove('success');
                el.classList.add('found');
            }, 500);
        });

        this.selectedIndices = [];
        this.updateSelectionDisplay();
        this.addWordToLog(wordObj);

        setTimeout(() => this.checkGameComplete(), 550);
    }

    checkGameComplete() {
        const remainingChars = [];
        for (let i = 0; i < this.gridLetters.length; i += 1) {
            const el = this.boardEl.children[i];
            if (!el.classList.contains('found')) {
                remainingChars.push(this.gridLetters[i]);
            }
        }

        if (remainingChars.length === 0) {
            this.completeOverlay.classList.remove('hidden');
            return;
        }

        const remainFreq = {};
        for (const char of remainingChars) {
            remainFreq[char] = (remainFreq[char] || 0) + 1;
        }

        for (let i = 0; i < dictionary.length; i += 1) {
            const word = dictionary[i].word;
            if (!word) continue;

            const wordFreq = {};
            for (const char of word) {
                wordFreq[char] = (wordFreq[char] || 0) + 1;
            }

            let canForm = true;
            for (const char in wordFreq) {
                if (!remainFreq[char] || remainFreq[char] < wordFreq[char]) {
                    canForm = false;
                    break;
                }
            }

            if (canForm) return;
        }

        this.completeOverlay.classList.remove('hidden');
    }

    updateSelectionDisplay() {
        if (this.selectedIndices.length === 0) {
            this.selectionDisplayEl.innerHTML = '<span class="placeholder">글자를 클릭하세요</span>';
        } else {
            const str = this.selectedIndices.map(idx => this.gridLetters[idx]).join('');
            this.selectionDisplayEl.innerHTML = str;
        }
    }

    addWordToLog(wordObj) {
        const card = document.createElement('div');
        card.classList.add('word-card');
        card.innerHTML = `
            <div class="word-title">${wordObj.word}</div>
            <div class="word-meaning">${wordObj.meaning}</div>
        `;
        this.foundWordsListEl.insertBefore(card, this.foundWordsListEl.firstChild);

        const currentFoundVal = parseInt(this.foundCountEl.innerText, 10) || 0;
        this.foundCountEl.innerText = `${currentFoundVal + 1}`;
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.updatePauseUI();
    }

    updatePauseUI() {
        if (this.isPaused) {
            this.pauseOverlay.classList.remove('hidden');
            this.btnPause.innerText = '계속하기';
        } else {
            this.pauseOverlay.classList.add('hidden');
            this.btnPause.innerText = '일시정지';
        }
    }
}
