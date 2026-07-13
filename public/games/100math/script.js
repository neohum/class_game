document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const startScreen = document.getElementById('start-screen');
    const gameScreen = document.getElementById('game-screen');
    const gameModeLabel = document.getElementById('game-mode-label');
    const resultModal = document.getElementById('result-modal');
    const recordsModal = document.getElementById('records-modal');
    const finalTimeDisplay = document.getElementById('final-time');
    
    // Settings Elements
    const sizeRadios = document.querySelectorAll('input[name="size"]');
    const p3Radio = document.getElementById('p3');
    const p3Label = document.getElementById('label-p3');
    const p2Radio = document.getElementById('p2');
    const p6Radio = document.getElementById('p6');
    const p6Label = document.getElementById('label-p6');
    
    // Settings
    let gameSize = 10;
    let operator = '+';
    let playersCount = 1;
    
    // Game State
    let timerInterval = null;
    let startTime = 0;
    let totalCells = 0;
    let playersData = [];
    let finishedPlayers = 0;
    
    // Chart instance
    let recordChart = null;

    // Initialize Event Listeners
    document.getElementById('start-btn').addEventListener('click', startGame);
    document.getElementById('retry-btn').addEventListener('click', startGame);
    document.getElementById('home-btn').addEventListener('click', showStartScreen);
    
    document.getElementById('records-btn').addEventListener('click', showRecords);
    document.getElementById('close-records').addEventListener('click', () => recordsModal.classList.remove('active'));
    document.getElementById('record-mode-select').addEventListener('change', updateRecordDisplay);

    // Disable 3-player for 100 cells
    sizeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === '100') {
                p3Radio.disabled = true;
                p3Label.style.opacity = '0.5';
                p3Label.style.cursor = 'not-allowed';
                p6Radio.disabled = true;
                p6Label.style.opacity = '0.5';
                p6Label.style.cursor = 'not-allowed';
                if (p3Radio.checked || p6Radio.checked) {
                    p2Radio.checked = true;
                }
            } else {
                p3Radio.disabled = false;
                p3Label.style.opacity = '1';
                p3Label.style.cursor = 'pointer';
                p6Radio.disabled = false;
                p6Label.style.opacity = '1';
                p6Label.style.cursor = 'pointer';
            }
        });
    });

    function showStartScreen() {
        clearInterval(timerInterval);
        startScreen.classList.add('active');
        gameScreen.classList.remove('active');
        resultModal.classList.remove('active');
    }

    function startGame() {
        gameSize = parseInt(document.querySelector('input[name="size"]:checked').value);
        operator = document.querySelector('input[name="operator"]:checked').value;
        playersCount = parseInt(document.querySelector('input[name="players"]:checked').value);
        
        let cols, rows;
        if (gameSize === 10) { cols = 5; rows = 2; }
        else if (gameSize === 25) { cols = 5; rows = 5; }
        else if (gameSize === 100) { cols = 10; rows = 10; }
        
        totalCells = cols * rows;
        playersData = [];
        finishedPlayers = 0;
        
        gameModeLabel.textContent = `${gameSize}칸 (${operator}) - ${playersCount}인용`;
        
        const container = document.getElementById('players-container');
        container.innerHTML = '';
        
        for (let p = 0; p < playersCount; p++) {
            const pData = {
                id: p,
                correctCount: 0,
                inputElements: [],
                finishTime: null,
                startTime: performance.now(),
                element: null,
                statusElement: null,
                timerElement: null
            };
            playersData.push(pData);
            
            const playerArea = createPlayerAreaSkeleton(pData);
            container.appendChild(playerArea);
            pData.element = playerArea;
            
            initPlayerBoard(pData);
        }
        
        startScreen.classList.remove('active');
        resultModal.classList.remove('active');
        gameScreen.classList.add('active');
        
        // Start Timer
        startTime = performance.now();
        clearInterval(timerInterval);
        timerInterval = setInterval(updateTimer, 50);
    }

    function updateTimer() {
        const now = performance.now();
        playersData.forEach(p => {
            if (p.finishTime === null && p.timerElement) {
                const elapsed = now - p.startTime;
                p.timerElement.textContent = formatTime(elapsed);
            }
        });
    }

    function formatTime(ms) {
        const totalSentis = Math.floor(ms / 10);
        const centis = totalSentis % 100;
        const totalSeconds = Math.floor(ms / 1000);
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60);
        
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}0`;
    }

    function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    function generateHeaders(count, start) {
        let arr = [];
        for (let i = 0; i < 10; i++) arr.push(start + i);
        shuffle(arr);
        return arr.slice(0, count);
    }

    function createPlayerAreaSkeleton(pData) {
        const area = document.createElement('div');
        area.className = 'player-area';
        
        // Header
        const header = document.createElement('div');
        header.className = 'player-header';
        
        const name = document.createElement('div');
        name.className = 'player-name';
        name.textContent = `Player ${pData.id + 1}`;
        
        const timerEl = document.createElement('div');
        timerEl.className = 'player-timer';
        timerEl.textContent = '00:00.000';
        pData.timerElement = timerEl;
        
        const status = document.createElement('div');
        status.className = 'player-status';
        status.textContent = '0%';
        pData.statusElement = status;
        
        const rightGroup = document.createElement('div');
        rightGroup.className = 'player-header-right';
        rightGroup.appendChild(timerEl);
        rightGroup.appendChild(status);
        
        header.appendChild(name);
        header.appendChild(rightGroup);
        area.appendChild(header);
        
        // Board Container
        const boardContainer = document.createElement('div');
        boardContainer.className = 'board-container';
        area.appendChild(boardContainer);
        
        // Keyboard Section
        const keyboardHtml = `
            <div class="keyboard-section">
                <div class="virtual-keyboard">
                    <button class="v-key" data-key="1">1</button>
                    <button class="v-key" data-key="2">2</button>
                    <button class="v-key" data-key="3">3</button>
                    <button class="v-key" data-key="4">4</button>
                    <button class="v-key" data-key="5">5</button>
                    <button class="v-key" data-key="6">6</button>
                    <button class="v-key" data-key="7">7</button>
                    <button class="v-key" data-key="8">8</button>
                    <button class="v-key" data-key="9">9</button>
                    <button class="v-key action-key" data-key="clear">C</button>
                    <button class="v-key" data-key="0">0</button>
                    <button class="v-key action-key" data-key="delete">⌫</button>
                </div>
                <div class="side-controls">
                </div>
            </div>
        `;
        area.insertAdjacentHTML('beforeend', keyboardHtml);
        
        const virtualKeyboard = area.querySelector('.virtual-keyboard');
        virtualKeyboard.addEventListener('pointerdown', (e) => {
            const keyBtn = e.target.closest('.v-key');
            if (!keyBtn) return;
            
            e.preventDefault();
            
            const activeInput = area.querySelector('.active-cell');
            if (!activeInput || activeInput.disabled) return;
            
            const key = keyBtn.dataset.key;
            
            if (key === 'clear') {
                activeInput.value = '';
            } else if (key === 'delete') {
                activeInput.value = activeInput.value.slice(0, -1);
            } else {
                if (activeInput.value.length < 4) {
                    activeInput.value += key;
                }
            }
            
            activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        
        return area;
    }

    function initPlayerBoard(pData) {
        let cols, rows;
        if (gameSize === 10) { cols = 5; rows = 2; }
        else if (gameSize === 25) { cols = 5; rows = 5; }
        else if (gameSize === 100) { cols = 10; rows = 10; }
        const op = operator;

        const area = pData.element;
        const boardContainer = area.querySelector('.board-container');
        boardContainer.innerHTML = '';
        
        pData.correctCount = 0;
        pData.finishTime = null;
        pData.startTime = performance.now();
        pData.inputElements = [];
        pData.statusElement.textContent = '0%';
        area.classList.remove('finished');
        
        const board = document.createElement('div');
        board.className = 'board';
        board.style.gridTemplateColumns = `repeat(${cols + 1}, var(--cell-size))`;
        
        let topHeaders = generateHeaders(cols, 0);
        let leftHeaders = [];
        if (op === '-') leftHeaders = generateHeaders(rows, 10);
        else leftHeaders = generateHeaders(rows, 0);
        
        // Corner Cell
        const cornerCell = document.createElement('div');
        cornerCell.className = 'cell corner';
        cornerCell.textContent = op;
        board.appendChild(cornerCell);
        
        // Top Headers Render
        for (let j = 0; j < cols; j++) {
            const cell = document.createElement('div');
            cell.className = 'cell header top-header';
            cell.textContent = topHeaders[j];
            board.appendChild(cell);
        }
        
        // Rows Render
        for (let i = 0; i < rows; i++) {
            const rowHeader = document.createElement('div');
            rowHeader.className = 'cell header left-header';
            rowHeader.textContent = leftHeaders[i];
            board.appendChild(rowHeader);
            
            for (let j = 0; j < cols; j++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                
                const input = document.createElement('input');
                input.type = 'number';
                
                let answer = 0;
                if (op === '+') answer = leftHeaders[i] + topHeaders[j];
                else if (op === '-') answer = leftHeaders[i] - topHeaders[j];
                else if (op === 'x') answer = leftHeaders[i] * topHeaders[j];
                
                input.dataset.answer = answer;
                
                input.addEventListener('input', (e) => handleInput(e, pData));
                
                input.addEventListener('pointerdown', (e) => {
                    pData.inputElements.forEach(el => el.classList.remove('active-cell'));
                    input.classList.add('active-cell');
                });
                
                input.addEventListener('focus', () => {
                    pData.inputElements.forEach(el => el.classList.remove('active-cell'));
                    input.classList.add('active-cell');
                });
                
                cell.appendChild(input);
                board.appendChild(cell);
                pData.inputElements.push(input);
            }
        }
        
        boardContainer.appendChild(board);
        
        // Reset controls
        const sideControls = area.querySelector('.side-controls');
        sideControls.innerHTML = '<button class="danger-btn player-giveup-btn">포기</button>';
        sideControls.querySelector('.player-giveup-btn').addEventListener('click', showStartScreen);
        
        // Focus first input
        if (pData.inputElements.length > 0) {
            pData.inputElements[0].classList.add('active-cell');
            if (playersCount === 1) {
                pData.inputElements[0].focus();
            }
        }
    }

    function handleInput(e, pData) {
        if (pData.finishTime !== null) return;
        
        const input = e.target;
        const valStr = input.value;
        if (valStr === '') return;
        
        const val = parseInt(valStr);
        const answer = parseInt(input.dataset.answer);
        const answerStr = String(answer);
        
        if (val === answer) {
            input.classList.remove('error', 'active-cell');
            input.classList.add('correct');
            input.disabled = true;
            pData.correctCount++;
            
            const percent = Math.floor((pData.correctCount / totalCells) * 100);
            pData.statusElement.textContent = `${percent}%`;
            
            if (pData.correctCount >= totalCells) {
                playerFinished(pData);
            } else {
                focusNextInput(input, pData);
            }
        } else {
            if (valStr.length >= answerStr.length) {
                input.classList.add('error');
                setTimeout(() => {
                    if (!input.disabled) {
                        input.classList.remove('error');
                        input.value = '';
                    }
                }, 350);
            } else {
                input.classList.remove('error');
            }
        }
    }

    function focusNextInput(currentInput, pData) {
        const currentIndex = pData.inputElements.indexOf(currentInput);
        let nextIndex = currentIndex + 1;
        
        while (nextIndex !== currentIndex) {
            if (nextIndex >= pData.inputElements.length) {
                nextIndex = 0;
            }
            if (!pData.inputElements[nextIndex].disabled) {
                pData.inputElements[nextIndex].classList.add('active-cell');
                if (playersCount === 1) {
                    pData.inputElements[nextIndex].focus();
                }
                return;
            }
            nextIndex++;
        }
    }

    function playerFinished(pData) {
        pData.finishTime = performance.now() - pData.startTime;
        pData.statusElement.textContent = "완료";
        pData.element.classList.add('finished');
        
        if (playersCount === 1) {
            finishedPlayers++;
            finishGame();
        } else {
            const sideControls = pData.element.querySelector('.side-controls');
            sideControls.innerHTML = '<button class="primary-btn player-restart-btn" style="padding: 10px 18px; border-radius: 12px; font-size: 1rem;">다시 시작</button>';
            sideControls.querySelector('.player-restart-btn').addEventListener('click', () => {
                initPlayerBoard(pData);
            });
        }
    }

    function finishGame() {
        clearInterval(timerInterval);
        
        if (playersCount === 1) {
            saveRecord(gameSize, operator, playersData[0].finishTime);
            finalTimeDisplay.textContent = formatTime(playersData[0].finishTime);
            document.getElementById('result-message').textContent = '수고했어요! 조금씩 더 빨라질 수 있어요. 💪';
            
            setTimeout(() => {
                resultModal.classList.add('active');
            }, 400);
        }
    }
    
    // --- Local Storage Management ---
    function getRecords() {
        try {
            const stored = localStorage.getItem('100math_records');
            if (stored) return JSON.parse(stored);
        } catch(e) {
            console.error("Local Storage parsing error:", e);
        }
        return { records: [] };
    }
    
    function saveRecord(size, op, timeMs) {
        const data = getRecords();
        const mode = `${size}_${op}`;
        
        data.records.push({
            date: new Date().toISOString(),
            mode: mode,
            time: timeMs
        });
        
        localStorage.setItem('100math_records', JSON.stringify(data));
    }
    
    function showRecords() {
        recordsModal.classList.add('active');
        updateRecordDisplay();
    }
    
    function updateRecordDisplay() {
        const mode = document.getElementById('record-mode-select').value;
        const data = getRecords();
        
        const modeRecords = data.records
            .filter(r => r.mode === mode)
            .sort((a, b) => new Date(a.date) - new Date(b.date));
                                         
        if (modeRecords.length === 0) {
            document.getElementById('best-time').textContent = '기록 없음';
            if (recordChart) {
                recordChart.destroy();
                recordChart = null;
            }
            return;
        }
        
        const bestTimeMs = Math.min(...modeRecords.map(r => r.time));
        document.getElementById('best-time').textContent = formatTime(bestTimeMs);
        
        const chartData = modeRecords.slice(-10); // get last 10 records
        renderChart(chartData);
    }
    
    function renderChart(data) {
        const ctx = document.getElementById('recordChart').getContext('2d');
        if (recordChart) recordChart.destroy();
        
        const labels = data.map((_, i) => `${i+1}회`);
        const times = data.map(r => (r.time / 1000).toFixed(2));
        
        recordChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: '클리어 시간 (초)',
                    data: times,
                    borderColor: '#5B8DEF',
                    backgroundColor: 'rgba(91, 141, 239, 0.15)',
                    borderWidth: 4,
                    pointBackgroundColor: '#FF6B9D',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    fill: true,
                    tension: 0.35
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        title: { display: true, text: '시간 (초)', font: {weight: 'bold'} }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return `시간: ${context.parsed.y}초`;
                            }
                        }
                    }
                }
            }
        });
    }
});
