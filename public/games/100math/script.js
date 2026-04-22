document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const startScreen = document.getElementById('start-screen');
    const gameScreen = document.getElementById('game-screen');
    const board = document.getElementById('board');
    const timerDisplay = document.getElementById('timer');
    const gameModeLabel = document.getElementById('game-mode-label');
    const resultModal = document.getElementById('result-modal');
    const recordsModal = document.getElementById('records-modal');
    const finalTimeDisplay = document.getElementById('final-time');
    
    // Settings
    let gameSize = 10;
    let operator = '+';
    
    // Game State
    let timerInterval = null;
    let startTime = 0;
    let totalCells = 0;
    let correctCount = 0;
    let inputElements = [];
    
    // Chart instance
    let recordChart = null;

    // Initialize Event Listeners
    document.getElementById('start-btn').addEventListener('click', startGame);
    document.getElementById('giveup-btn').addEventListener('click', showStartScreen);
    document.getElementById('retry-btn').addEventListener('click', startGame);
    document.getElementById('home-btn').addEventListener('click', showStartScreen);
    
    document.getElementById('records-btn').addEventListener('click', showRecords);
    document.getElementById('close-records').addEventListener('click', () => recordsModal.classList.remove('active'));
    document.getElementById('record-mode-select').addEventListener('change', updateRecordDisplay);

    function showStartScreen() {
        clearInterval(timerInterval);
        startScreen.classList.add('active');
        gameScreen.classList.remove('active');
        resultModal.classList.remove('active');
    }

    function startGame() {
        gameSize = parseInt(document.querySelector('input[name="size"]:checked').value);
        operator = document.querySelector('input[name="operator"]:checked').value;
        
        let cols, rows;
        if (gameSize === 10) { cols = 5; rows = 2; }
        else if (gameSize === 25) { cols = 5; rows = 5; }
        else if (gameSize === 100) { cols = 10; rows = 10; }
        
        totalCells = cols * rows;
        correctCount = 0;
        inputElements = [];
        
        gameModeLabel.textContent = `${gameSize}칸 (${operator})`;
        
        generateBoard(cols, rows, operator);
        
        startScreen.classList.remove('active');
        resultModal.classList.remove('active');
        gameScreen.classList.add('active');
        
        // Start Timer
        timerDisplay.textContent = '00:00.000';
        startTime = performance.now();
        clearInterval(timerInterval);
        timerInterval = setInterval(updateTimer, 50);
        
        // Focus first input
        if (inputElements.length > 0) {
            inputElements[0].focus();
        }
    }

    function updateTimer() {
        const elapsed = performance.now() - startTime;
        timerDisplay.textContent = formatTime(elapsed);
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

    function generateBoard(cols, rows, op) {
        board.innerHTML = '';
        board.style.gridTemplateColumns = `repeat(${cols + 1}, var(--cell-size))`;
        
        // 가로축 헤더 (Top Headers). 항상 0~9
        let topHeaders = generateHeaders(cols, 0);
        
        // 세로축 헤더 (Left Headers).
        let leftHeaders = [];
        if (op === '-') {
            // 뺄셈인 경우 음수를 방지하기 위해 큰 수(10~19)에서 뺌
            leftHeaders = generateHeaders(rows, 10);
        } else if (op === 'x') {
            // 곱셈인 경우 너무 쉬운 0을 제외하길 선호할 수도 있지만 일단 0~9 사용
            leftHeaders = generateHeaders(rows, 0);
        } else {
            leftHeaders = generateHeaders(rows, 0);
        }
        
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
                
                // Calculate correct answer
                let answer = 0;
                if (op === '+') answer = leftHeaders[i] + topHeaders[j];
                else if (op === '-') answer = leftHeaders[i] - topHeaders[j];
                else if (op === 'x') answer = leftHeaders[i] * topHeaders[j];
                
                input.dataset.answer = answer;
                
                // Event listener on input to check instantly
                input.addEventListener('input', handleInput);
                
                cell.appendChild(input);
                board.appendChild(cell);
                inputElements.push(input);
            }
        }
    }

    function handleInput(e) {
        const input = e.target;
        const valStr = input.value;
        if (valStr === '') return;
        
        const val = parseInt(valStr);
        const answer = parseInt(input.dataset.answer);
        const answerStr = String(answer);
        
        if (val === answer) {
            // Correct format instantly
            input.classList.remove('error');
            input.classList.add('correct');
            input.disabled = true;
            correctCount++;
            
            if (correctCount >= totalCells) {
                finishGame();
            } else {
                focusNextInput(input);
            }
        } else {
            // Error checking - visually indicate only if length matches or exceeds answer
            if (valStr.length >= answerStr.length) {
                input.classList.add('error');
                // Auto-clear string after small delay for UX
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

    function focusNextInput(currentInput) {
        const currentIndex = inputElements.indexOf(currentInput);
        let nextIndex = currentIndex + 1;
        
        while (nextIndex !== currentIndex) {
            if (nextIndex >= inputElements.length) {
                nextIndex = 0; // Wrap around
            }
            if (!inputElements[nextIndex].disabled) {
                inputElements[nextIndex].focus();
                return;
            }
            nextIndex++;
        }
    }

    function finishGame() {
        clearInterval(timerInterval);
        const finalTimeMs = performance.now() - startTime;
        const timeStr = formatTime(finalTimeMs);
        
        finalTimeDisplay.textContent = timeStr;
        
        saveRecord(gameSize, operator, finalTimeMs);
        
        setTimeout(() => {
            resultModal.classList.add('active');
        }, 400);
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
