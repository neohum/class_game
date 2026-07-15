// 네모네모 로직 핵심 게임 스크립트

// 마우스 오른쪽 클릭 컨텍스트 메뉴 차단
document.addEventListener('contextmenu', e => e.preventDefault());

// === 전역 상태 관리 ===
let gameState = "home"; // "home" | "team_tutorial_lobby" | "solo_lobby" | "solo_play" | "multi_lobby" | "multi_play"
let currentLevel = null; // 숫자(1~200) 또는 튜토리얼ID("t1"~"t4")
let solvedLevels = [];   // 솔로 모드에서 완료한 레벨 ID들

// 솔로 플레이어 상태
let soloState = {
  board: [],       // 2D 배열 (0: 빈칸, 1: 칠함, 2: X)
  target: [],      // 2D 배열 (정답 0 / 1)
  size: 3,
  name: "",
  activeTool: "pencil", // "pencil" | "x"
  errors: 0,
  completed: false,
  isTutorial: false,
  guideText: ""
};

// 멀티플레이어 상태
let multiPlayers = []; // { id, name, board, activeTool, errors, finished, finishedTime, progress }
let multiPuzzle = null;
let gameStartTime = 0;
let multiTimerInterval = null;
let completedPlayers = []; // { name, time, errors }
let selectedMultiMode = "normal"; // "normal" | "tutorial"

// 6인 동시 튜토리얼 상태
let teamTutorialState = {
  active: false,
  stageIndex: 0,
  countdownInterval: null,
  stageCompleteShown: false
};

// 마우스/터치 드래그용 상태
let isPointerDown = false;
let soloPointerId = null;
let activePointerDowns = {}; // playerId -> pointerId, 여러 명의 동시 터치를 서로 격리
let dragStartValues = {}; // "playerId:pointerId" -> 이번 드래그에서 적용할 값

// === Web Audio API 효과음 생성 시스템 ===
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playSound(type) {
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const now = audioCtx.currentTime;
    
    if (type === 'pencil') {
      // 맑고 경쾌한 실로폰 소리
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(783.99, now); // G5
      osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.1); // C6로 튕김
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (type === 'x') {
      // 톡! 가벼운 X 표시 소리
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(10, now + 0.05);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'error') {
      // 뿡~ 귀여운 틀림음
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.linearRampToValueAtTime(110, now + 0.25);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'clear') {
      // 따라라란~ 축하 멜로디 (도미솔도)
      const notes = [523.25, 659.25, 783.99, 1046.50]; 
      notes.forEach((freq, index) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g);
        g.connect(audioCtx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(freq, now + index * 0.08);
        g.gain.setValueAtTime(0.15, now + index * 0.08);
        g.gain.exponentialRampToValueAtTime(0.01, now + index * 0.08 + 0.18);
        o.start(now + index * 0.08);
        o.stop(now + index * 0.08 + 0.2);
      });
    } else if (type === 'win') {
      // 아주 화려한 팡파르!
      const fanfares = [523.25, 523.25, 523.25, 523.25, 659.25, 587.33, 659.25, 783.99, 1046.50];
      const durations = [0.08, 0.08, 0.08, 0.24, 0.12, 0.12, 0.12, 0.12, 0.5];
      let accumTime = 0;
      fanfares.forEach((freq, index) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g);
        g.connect(audioCtx.destination);
        o.type = 'triangle';
        o.frequency.setValueAtTime(freq, now + accumTime);
        g.gain.setValueAtTime(0.15, now + accumTime);
        g.gain.exponentialRampToValueAtTime(0.01, now + accumTime + durations[index] - 0.02);
        o.start(now + accumTime);
        o.stop(now + accumTime + durations[index]);
        accumTime += durations[index];
      });
    }
  } catch (e) {
    console.warn("오디오 재생 실패:", e);
  }
}

// === 내장 Canvas 폭죽 파티클 시스템 ===
const canvas = document.getElementById('canvas-confetti');
const ctx = canvas.getContext('2d');
let particles = [];
let animFrameId = null;

function resizeConfetti() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeConfetti);

class ConfettiParticle {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.size = Math.random() * 8 + 6;
    // 화사한 파스텔 색상 무작위 지정
    this.color = `hsl(${Math.random() * 360}, 90%, 65%)`;
    this.speedX = Math.random() * 10 - 5;
    this.speedY = Math.random() * -14 - 6; // 하늘로 솟아오름
    this.gravity = 0.35;
    this.rotation = Math.random() * 360;
    this.rotationSpeed = Math.random() * 12 - 6;
    this.life = 100;
  }
  update() {
    this.speedY += this.gravity;
    this.x += this.speedX;
    this.y += this.speedY;
    this.rotation += this.rotationSpeed;
    this.life -= 1.2;
  }
  draw() {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.fillStyle = this.color;
    ctx.fillRect(-this.size / 2, -this.size / 2, this.size, this.size);
    ctx.restore();
  }
}

function startConfetti() {
  resizeConfetti();
  particles = [];
  const w = canvas.width;
  const h = canvas.height;
  
  // 왼쪽, 오른쪽, 중앙 3곳에서 마구 분출시킴
  const launchPoints = [w * 0.2, w * 0.5, w * 0.8];
  
  launchPoints.forEach(x => {
    for (let i = 0; i < 60; i++) {
      particles.push(new ConfettiParticle(x, h + 10));
    }
  });
  
  if (animFrameId) cancelAnimationFrame(animFrameId);
  updateConfetti();
}

function updateConfetti() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles = particles.filter(p => p.life > 0 && p.y < canvas.height + 20);
  particles.forEach(p => {
    p.update();
    p.draw();
  });
  
  if (particles.length > 0) {
    animFrameId = requestAnimationFrame(updateConfetti);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// === 네모네모 로직 코어 엔진 ===

// 1차원 grid 문자열("101001...")을 2차원 배열로 파싱
function parseGridString(gridStr, size) {
  const grid2D = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push(parseInt(gridStr[r * size + c]) || 0);
    }
    grid2D.push(row);
  }
  return grid2D;
}

// 행/열의 연속된 1의 개수를 세어 힌트 리스트 생성
function generateClues(grid2D, size) {
  const rowClues = [];
  const colClues = [];

  // 가로(행) 힌트 계산
  for (let r = 0; r < size; r++) {
    const clues = [];
    let count = 0;
    for (let c = 0; c < size; c++) {
      if (grid2D[r][c] === 1) {
        count++;
      } else {
        if (count > 0) {
          clues.push(count);
          count = 0;
        }
      }
    }
    if (count > 0) clues.push(count);
    if (clues.length === 0) clues.push(0); // 빈 줄인 경우
    rowClues.push(clues);
  }

  // 세로(열) 힌트 계산
  for (let c = 0; c < size; c++) {
    const clues = [];
    let count = 0;
    for (let r = 0; r < size; r++) {
      if (grid2D[r][c] === 1) {
        count++;
      } else {
        if (count > 0) {
          clues.push(count);
          count = 0;
        }
      }
    }
    if (count > 0) clues.push(count);
    if (clues.length === 0) clues.push(0); // 빈 열인 경우
    colClues.push(clues);
  }

  return { row: rowClues, col: colClues };
}

// 정답 매칭 확인 (X 표시는 무관, 연필 칠한 곳만 일치하면 됨)
function checkVictory(board2D, target2D) {
  const size = board2D.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const isTargetFilled = (target2D[r][c] === 1);
      const isBoardFilled = (board2D[r][c] === 1);
      if (isTargetFilled !== isBoardFilled) {
        return false;
      }
    }
  }
  return true;
}

// 현재 퍼즐 진행률 계산 (%)
function calculateProgress(board2D, target2D) {
  const size = board2D.length;
  let targetFilledCount = 0;
  let playerFilledCorrect = 0;
  let playerFilledWrong = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (target2D[r][c] === 1) {
        targetFilledCount++;
        if (board2D[r][c] === 1) playerFilledCorrect++;
      } else {
        if (board2D[r][c] === 1) playerFilledWrong++;
      }
    }
  }

  if (targetFilledCount === 0) return 100;
  // 오답 패널티를 포함하여 진행도를 귀엽게 계산 (최소 0)
  const score = Math.round(((playerFilledCorrect - playerFilledWrong) / targetFilledCount) * 100);
  return Math.max(0, Math.min(100, score));
}

// X표까지 연습하는 튜토리얼은 색칠 칸과 빈칸 표시를 모두 진행률에 포함한다.
function calculateTeamTutorialProgress(board2D, target2D, requireX) {
  if (!requireX) return calculateProgress(board2D, target2D);

  let correct = 0;
  const total = board2D.length * board2D.length;
  for (let r = 0; r < board2D.length; r++) {
    for (let c = 0; c < board2D.length; c++) {
      const expected = target2D[r][c] === 1 ? 1 : 2;
      if (board2D[r][c] === expected) correct++;
    }
  }
  return Math.round((correct / total) * 100);
}

function checkTeamTutorialVictory(board2D, target2D, requireX) {
  if (!checkVictory(board2D, target2D)) return false;
  if (!requireX) return true;

  for (let r = 0; r < board2D.length; r++) {
    for (let c = 0; c < board2D.length; c++) {
      if (target2D[r][c] === 0 && board2D[r][c] !== 2) return false;
    }
  }
  return true;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// === 화면 및 조작 인터페이스 렌더러 ===

// 화면 전환 헬퍼
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(scr => {
    scr.classList.remove('active');
  });
  document.getElementById(screenId).classList.add('active');
  
  // 상태 동기화
  gameState = screenId.replace('-screen', '');
  if (screenId !== 'multi-play-screen') {
    stopMultiTimer();
  }
}

// 로컬스토리지 완료 기록 로드
function loadSolvedHistory() {
  try {
    const data = localStorage.getItem('nemonemo_logic_solved');
    solvedLevels = data ? JSON.parse(data) : [];
  } catch (e) {
    solvedLevels = [];
  }
}

// 로컬스토리지 완료 기록 저장
function saveSolvedHistory(levelId) {
  if (!solvedLevels.includes(levelId)) {
    solvedLevels.push(levelId);
    try {
      localStorage.setItem('nemonemo_logic_solved', JSON.stringify(solvedLevels));
    } catch (e) {
      console.warn("기록 저장 실패:", e);
    }
  }
}

// 메인 화면 로드
window.addEventListener('DOMContentLoaded', () => {
  loadSolvedHistory();
  showScreen('home-screen');
  setupEventListeners();
});

// 전역 이벤트 리스너 설정
function setupEventListeners() {
  // 메인 카드 클릭
  const tutorialCard = document.getElementById('btn-goto-team-tutorial');
  const openTeamTutorialLobby = () => {
    initAudio();
    setupTeamTutorialLobby();
    showScreen('team-tutorial-lobby-screen');
  };
  tutorialCard.addEventListener('click', openTeamTutorialLobby);
  tutorialCard.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openTeamTutorialLobby();
    }
  });

  document.getElementById('btn-goto-solo').addEventListener('click', () => {
    initAudio();
    renderSoloLobby();
    showScreen('solo-lobby-screen');
  });
  document.getElementById('btn-goto-multi').addEventListener('click', () => {
    initAudio();
    setupMultiLobbyForm();
    showScreen('multi-lobby-screen');
  });

  // 뒤로가기 버튼들
  document.querySelectorAll('.back-to-home').forEach(btn => {
    btn.addEventListener('click', () => {
      stopTeamTutorialCountdown();
      showScreen('home-screen');
    });
  });

  document.getElementById('btn-start-team-tutorial').addEventListener('click', startTeamTutorial);
  document.getElementById('btn-team-tutorial-exit').addEventListener('click', leaveTeamTutorial);
  document.getElementById('btn-team-tutorial-hint').addEventListener('click', showNextTeamTutorialHint);

  // 드래그 종료를 위한 글로벌 포인터 리스너
  const releasePointerDrag = (event) => {
    if (soloPointerId === event.pointerId) {
      isPointerDown = false;
      soloPointerId = null;
      delete dragStartValues[`solo:${event.pointerId}`];
    }
    Object.entries(activePointerDowns).forEach(([playerId, pointerId]) => {
      if (pointerId === event.pointerId) {
        delete activePointerDowns[playerId];
        delete dragStartValues[`${playerId}:${event.pointerId}`];
      }
    });
  };
  window.addEventListener('pointerup', releasePointerDrag);
  window.addEventListener('pointercancel', releasePointerDrag);
}

// === 솔로 로비 (레벨 셀렉터) 구현 ===
function renderSoloLobby() {
  const container3 = document.getElementById('level-grid-3x3');
  const container4 = document.getElementById('level-grid-4x4');
  const container5 = document.getElementById('level-grid-5x5');

  container3.innerHTML = '';
  container4.innerHTML = '';
  container5.innerHTML = '';

  // 튜토리얼 4단계 추가
  TUTORIAL_PUZZLES.forEach((tut, idx) => {
    const btn = document.createElement('div');
    const isCleared = solvedLevels.includes(tut.id);
    btn.className = `level-btn ${isCleared ? 'completed' : ''}`;
    btn.style.background = '#e0e7ff'; // 튜토리얼 전용 이쁜 연보라
    btn.style.borderColor = '#818cf8';
    btn.innerHTML = `
      <span style="font-size:0.85rem;color:#4f46e5;">기초</span>
      <span>${idx + 1}</span>
      <span class="size-tag">${tut.size}x${tut.size}</span>
    `;
    btn.addEventListener('click', () => startSoloPlay(tut, true));
    container3.appendChild(btn);
  });

  // 정식 200단계 분배
  PUZZLES.forEach(puzzle => {
    const btn = document.createElement('div');
    const isCleared = solvedLevels.includes(puzzle.id);
    btn.className = `level-btn ${isCleared ? 'completed' : ''}`;
    btn.innerHTML = `
      <span style="font-size:0.75rem;font-weight:normal;color:#94a3b8;">단계</span>
      <span>${puzzle.id}</span>
      <span class="size-tag">${puzzle.size}x${puzzle.size}</span>
    `;
    btn.addEventListener('click', () => startSoloPlay(puzzle, false));

    if (puzzle.size === 3) {
      container3.appendChild(btn);
    } else if (puzzle.size === 4) {
      container4.appendChild(btn);
    } else if (puzzle.size === 5) {
      container5.appendChild(btn);
    }
  });

  // 탭 전환 동작 연결
  const tabs = document.querySelectorAll('#solo-lobby-screen .tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetId = tab.dataset.target;
      document.querySelectorAll('.level-container').forEach(grid => {
        grid.classList.remove('active');
      });
      document.getElementById(targetId).classList.add('active');
    });
  });
}

// === 솔로 플레이 모드 구현 ===
function startSoloPlay(puzzle, isTutorial = false) {
  soloState.size = puzzle.size;
  soloState.name = puzzle.name;
  soloState.target = parseGridString(puzzle.grid, puzzle.size);
  soloState.board = Array(puzzle.size).fill(null).map(() => Array(puzzle.size).fill(0));
  soloState.activeTool = "pencil";
  soloState.errors = 0;
  soloState.completed = false;
  soloState.isTutorial = isTutorial;
  soloState.guideText = isTutorial ? puzzle.guide : `귀여운 <strong>${puzzle.name}</strong>을(를) 그려볼까요? 가로와 세로 숫자의 힌트를 잘 보고 알맞은 네모칸을 칠해보세요!`;
  
  currentLevel = puzzle.id;

  // UI 헤더/사이드바 업데이트
  document.getElementById('solo-title').innerText = isTutorial ? `배우기: ${puzzle.name}` : `${puzzle.id}단계 - ${puzzle.name}`;
  const guideEl = document.getElementById('solo-guide');
  guideEl.innerHTML = soloState.guideText;
  guideEl.style.display = isTutorial ? 'block' : 'none'; // 튜토리얼 가이드 노출 분기
  document.getElementById('solo-errors').innerText = soloState.errors;
  document.getElementById('solo-progress').innerText = '0%';

  // 도구 버튼 리셋
  document.getElementById('solo-tool-pencil').classList.add('active');
  document.getElementById('solo-tool-x').classList.remove('active');

  // 보드 렌더링
  renderBoard('solo-board-area', 'solo', soloState.board, soloState.target);

  // 도구 이벤트 리스너 바인딩
  document.getElementById('solo-tool-pencil').onclick = () => {
    soloState.activeTool = "pencil";
    document.getElementById('solo-tool-pencil').classList.add('active');
    document.getElementById('solo-tool-x').classList.remove('active');
  };
  document.getElementById('solo-tool-x').onclick = () => {
    soloState.activeTool = "x";
    document.getElementById('solo-tool-pencil').classList.remove('active');
    document.getElementById('solo-tool-x').classList.add('active');
  };

  showScreen('solo-play-screen');
}

// 보드 테이블 생성 및 렌더링 공통 함수
function renderBoard(targetAreaId, playerId, boardState, targetState) {
  const container = document.getElementById(targetAreaId);
  container.innerHTML = '';

  const size = boardState.length;
  const clues = generateClues(targetState, size);

  // Table 생성
  const table = document.createElement('table');
  table.className = 'nono-grid';

  // 1. 컬럼 헤더 행 (세로 힌트용)
  const colHeaderRow = document.createElement('tr');
  
  // 왼쪽 위 구석 빈칸 (가로 힌트가 위치할 너비만큼 차지해야 함)
  const cornerCell = document.createElement('th');
  cornerCell.className = 'corner-cell';
  colHeaderRow.appendChild(cornerCell);

  // 세로 힌트 채우기
  for (let c = 0; c < size; c++) {
    const th = document.createElement('th');
    th.className = 'col-header-cell';
    th.dataset.col = c;
    
    const clueCont = document.createElement('div');
    clueCont.className = 'clue-container';
    
    clues.col[c].forEach(num => {
      const span = document.createElement('span');
      span.className = 'clue-num';
      span.innerText = num;
      // 힌트 터치 시 취소선 긋는 재미요소 제공
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        span.classList.toggle('checked');
        playSound('x');
      });
      clueCont.appendChild(span);
    });
    
    th.appendChild(clueCont);
    colHeaderRow.appendChild(th);
  }
  table.appendChild(colHeaderRow);

  // 2. 가로 힌트 & 게임 격자 행 생성
  for (let r = 0; r < size; r++) {
    const row = document.createElement('tr');

    // 가로(행) 힌트 채우기
    const rowHeader = document.createElement('th');
    rowHeader.className = 'row-header-cell';
    rowHeader.dataset.row = r;
    
    const clueCont = document.createElement('div');
    clueCont.className = 'clue-container';

    clues.row[r].forEach(num => {
      const span = document.createElement('span');
      span.className = 'clue-num';
      span.innerText = num;
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        span.classList.toggle('checked');
        playSound('x');
      });
      clueCont.appendChild(span);
    });

    rowHeader.appendChild(clueCont);
    row.appendChild(rowHeader);

    // 실제 퍼즐 격자 셀 배치
    for (let c = 0; c < size; c++) {
      const cell = document.createElement('td');
      cell.className = 'nono-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;

      // 5칸 간격 굵은 선 (5x5은 필요없지만 10x10 등에 대비한 확장성)
      if (c === 4) cell.classList.add('border-right-thick');
      if (r === 4) cell.classList.add('border-bottom-thick');

      // 셀 상태 초기 복구
      updateCellVisual(cell, boardState[r][c]);

      // 포인터 이벤트 핸들러 바인딩 (터치 및 마우스 지원)
      cell.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        cell.releasePointerCapture(e.pointerId); // 드래그 시 다른 엘리먼트로 포인터 엔터가 가도록 방출
        if (playerId === 'solo') {
          isPointerDown = true;
          soloPointerId = e.pointerId;
        } else {
          activePointerDowns[playerId] = e.pointerId;
        }
        handleCellAction(playerId, r, c, cell, true, e.pointerId);
      });

      cell.addEventListener('pointerenter', (e) => {
        const isDown = (playerId === 'solo')
          ? (isPointerDown && soloPointerId === e.pointerId)
          : activePointerDowns[playerId] === e.pointerId;
        if (isDown) {
          handleCellAction(playerId, r, c, cell, false, e.pointerId);
        }
      });

      row.appendChild(cell);
    }
    table.appendChild(row);
  }

  container.appendChild(table);
}

// 셀 비주얼 상태 동기화
function updateCellVisual(cellElement, state) {
  cellElement.classList.remove('marked-fill', 'marked-x');
  if (state === 1) {
    cellElement.classList.add('marked-fill');
  } else if (state === 2) {
    cellElement.classList.add('marked-x');
  }
}

// 셀 탭/드래그 액션 처리 공통
function handleCellAction(playerId, r, c, cellElement, isClick = false, pointerId = 0) {
  // 1. 게임 상태 확인 및 쿨다운 페널티 검사
  const state = (playerId === 'solo') ? soloState : multiPlayers.find(p => p.id === playerId);
  if (!state || state.cooldownActive) return;

  if (playerId === 'solo') {
    if (soloState.completed) return;
  } else {
    if (state.finished || !state.startActive) return;
  }

  // 2. 관련 정보 추출
  const activeTool = state.activeTool;
  const currentVal = state.board[r][c];
  const isTargetFilled = (state.target[r][c] === 1);
  const dragKey = `${playerId}:${pointerId}`;

  // 3. 드래그 시작 시 액션 종류 결정
  if (isClick) {
    if (activeTool === 'pencil') {
      if (currentVal === 1) {
        // 이미 칠해져 있으면 지운다
        dragStartValues[dragKey] = 0;
      } else {
        // 안 칠해져 있으면 연필 칠하기 시도
        dragStartValues[dragKey] = 1;
      }
    } else { // X 도구인 경우
      if (currentVal === 2) {
        // 이미 X이면 지운다
        dragStartValues[dragKey] = 0;
      } else {
        // 아니면 X칠하기 시도
        dragStartValues[dragKey] = 2;
      }
    }
  }

  // dragStartValue가 설정되지 않았다면 기본값 지정
  if (dragStartValues[dragKey] === undefined) dragStartValues[dragKey] = 1;
  const dragStartValue = dragStartValues[dragKey];

  // 4. 셀 상태 변환 실행
  if (dragStartValue === 0) {
    // 지우기 모드: 칠한 거나 X 모두 지움
    if (state.board[r][c] !== 0) {
      state.board[r][c] = 0;
      updateCellVisual(cellElement, 0);
      playSound('x');
      if (selectedMultiMode === 'tutorial' && playerId !== 'solo') {
        checkProgressAndVictory(playerId, state);
      }
    }
  } 
  else if (dragStartValue === 1) {
    // 연필 칠하기 모드
    if (state.board[r][c] !== 1) {
      // 1학년용 실시간 오답 피드백: 정답이 아닌 곳을 칠하려 하면!
      if (!isTargetFilled) {
        // 잘못된 클릭인 경우: 붉은 경고 애니메이션 및 에러 카운트 증가
        if (isClick) {
          state.errors++;
          playSound('error');
          showErrorEffect(cellElement);
          updateErrorDisplay(playerId, state.errors);

          // 3회 실수마다 3초 조작 잠금 패널티 발동!
          if (selectedMultiMode !== 'tutorial' && state.errors > 0 && state.errors % 3 === 0) {
            triggerCooldownPenalty(playerId, state);
          }
        }
        // 드래그 중인 경우에는 진동 없이 스무스하게 무시하고 통과시킴
      } else {
        // 올바른 타겟 칠하기
        state.board[r][c] = 1;
        updateCellVisual(cellElement, 1);
        playSound('pencil');
        checkProgressAndVictory(playerId, state);
      }
    }
  } 
  else if (dragStartValue === 2) {
    // X 마크 칠하기 모드 (X는 정답 오답 상관없이 자유롭게 칠하고 지울 수 있음)
    if (state.board[r][c] !== 2) {
      state.board[r][c] = 2;
      updateCellVisual(cellElement, 2);
      playSound('x');
      if (selectedMultiMode === 'tutorial' && playerId !== 'solo') {
        checkProgressAndVictory(playerId, state);
      }
    }
  }
}

// 틀렸을 때 빨갛게 경고 깜빡이는 시 효과
function showErrorEffect(cellElement) {
  cellElement.style.backgroundColor = '#ef4444';
  cellElement.style.transform = 'scale(0.85)';
  setTimeout(() => {
    cellElement.style.backgroundColor = '';
    cellElement.style.transform = '';
  }, 350);
}

// 에러 횟수 표시부 업데이트
function updateErrorDisplay(playerId, errorCount) {
  if (playerId === 'solo') {
    document.getElementById('solo-errors').innerText = errorCount;
  } else {
    const errorSpan = document.getElementById(`multi-errors-${playerId}`);
    if (errorSpan) errorSpan.innerText = errorCount;
  }
}

// 진행률 실시간 반영 및 우승 판독
function checkProgressAndVictory(playerId, state) {
  const activeTeamStage = selectedMultiMode === 'tutorial' && Number.isInteger(state.tutorialStageIndex)
    ? TEAM_TUTORIAL_STAGES[state.tutorialStageIndex]
    : null;
  const prog = activeTeamStage
    ? calculateTeamTutorialProgress(state.board, state.target, activeTeamStage.requireX)
    : calculateProgress(state.board, state.target);
  
  if (playerId === 'solo') {
    document.getElementById('solo-progress').innerText = `${prog}%`;
    
    // 승리 판정
    if (checkVictory(state.board, state.target)) {
      state.completed = true;
      playSound('clear');
      startConfetti();
      
      // 기록 저장
      saveSolvedHistory(currentLevel);
      
      // 우승 팝업 표시
      showSoloClearModal();
    }
  } else {
    // 멀티플레이어인 경우
    state.progress = prog;
    const progSpan = document.getElementById(`multi-progress-${playerId}`);
    if (progSpan) progSpan.innerText = `${prog}%`;

    if (activeTeamStage) {
      if (checkTeamTutorialVictory(state.board, state.target, activeTeamStage.requireX)) {
        finishTeamTutorialPlayer(state);
      } else if (activeTeamStage.requireX && checkVictory(state.board, state.target)) {
        showTeamTutorialMissingXFeedback(state);
      }
      return;
    }

    if (checkVictory(state.board, state.target)) {
      state.finished = true;
      state.finishedTime = new Date().getTime();
      
      // 완료 시 보드 패널 스타일 변환
      const panel = document.getElementById(`player-panel-${playerId}`);
      if (panel) panel.classList.add('finished');

      playSound('clear');
      startConfetti();

      // 개별 완료 오버레이 추가
      if (panel) {
        // 이미 완료 오버레이가 있다면 지움
        const existing = document.getElementById(`clear-overlay-${playerId}`);
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'clear-overlay';
        overlay.id = `clear-overlay-${playerId}`;
        
        let nextPuzzleId = null;
        let nextBtnHtml = '';
        if (typeof state.currentPuzzleId === 'string' && state.currentPuzzleId.startsWith('t')) {
          const num = parseInt(state.currentPuzzleId.substring(1));
          if (num < 4) {
            nextPuzzleId = `t${num + 1}`;
            nextBtnHtml = `<button type="button" class="clear-overlay-btn" onclick="nextPlayerPuzzle(${playerId}, '${nextPuzzleId}')">🚀 다음 공부하기</button>`;
          } else {
            if (state.currentSize === 3 || state.currentSize === 4 || state.currentSize === 5) {
              const firstPuzzle = PUZZLES.find(p => p.size === state.currentSize);
              nextPuzzleId = firstPuzzle ? firstPuzzle.id : 1;
            } else {
              nextPuzzleId = `g_${state.currentSize}_1`;
            }
            nextBtnHtml = `<button type="button" class="clear-overlay-btn" onclick="nextPlayerPuzzle(${playerId}, ${typeof nextPuzzleId === 'string' ? `'${nextPuzzleId}'` : nextPuzzleId})">⭐ 1단계 풀기</button>`;
          }
        } else if (typeof state.currentPuzzleId === 'string' && state.currentPuzzleId.startsWith('g_')) {
          const parts = state.currentPuzzleId.split('_');
          const sz = parseInt(parts[1]);
          const idxId = parseInt(parts[2]);
          if (idxId < 200) {
            nextPuzzleId = `g_${sz}_${idxId + 1}`;
            nextBtnHtml = `<button type="button" class="clear-overlay-btn" onclick="nextPlayerPuzzle(${playerId}, '${nextPuzzleId}')">🚀 다음 단계 풀기</button>`;
          } else {
            nextBtnHtml = `<p style="color:#059669; font-weight:bold; margin-bottom:10px;">🎉 200단계를 모두 완료했어요!</p>`;
          }
        } else {
          const curId = parseInt(state.currentPuzzleId);
          if (curId < 200) {
            nextPuzzleId = curId + 1;
            nextBtnHtml = `<button type="button" class="clear-overlay-btn" onclick="nextPlayerPuzzle(${playerId}, ${nextPuzzleId})">🚀 다음 단계 풀기</button>`;
          } else {
            nextBtnHtml = `<p style="color:#059669; font-weight:bold; margin-bottom:10px;">🎉 200단계를 모두 완료했어요!</p>`;
          }
        }

        let countdownSec = 2; // 2초 후 자동 이동
        overlay.innerHTML = `
          <div class="clear-overlay-title">🎉 완성! 참 잘했어요!</div>
          <div class="clear-overlay-stats">
            걸린 시간: <strong>${state.elapsedSeconds}초</strong><br>
            실수 횟수: <strong>${state.errors}회</strong>
          </div>
          <div id="auto-next-message-${playerId}" style="font-size: 0.85rem; color: #059669; font-weight: bold; margin-bottom: 8px;">
            ${nextPuzzleId ? `⏱️ ${countdownSec}초 후 자동으로 다음 단계가 시작됩니다...` : ''}
          </div>
          <div class="clear-overlay-buttons">
            ${nextBtnHtml}
            <button type="button" class="clear-overlay-btn secondary" onclick="resetPlayerToLobby(${playerId})">📂 단계 변경</button>
          </div>
        `;
        panel.appendChild(overlay);

        if (nextPuzzleId) {
          const countdownInterval = setInterval(() => {
            countdownSec--;
            const msgEl = document.getElementById(`auto-next-message-${playerId}`);
            if (msgEl) {
              msgEl.innerText = `⏱️ ${countdownSec}초 후 자동으로 다음 단계가 시작됩니다...`;
            }
            if (countdownSec <= 0) {
              clearInterval(countdownInterval);
              if (document.getElementById(`clear-overlay-${playerId}`) && state.finished) {
                autoNextPlayerPuzzle(playerId, nextPuzzleId);
              }
            }
          }, 1000);
          state.autoNextInterval = countdownInterval;
        }
      }
    }
  }
}

// 솔로 클리어 팝업
function showSoloClearModal() {
  const modal = document.getElementById('clear-modal');
  const title = document.getElementById('modal-title');
  const bodyText = document.getElementById('modal-body');
  const actionBtn = document.getElementById('modal-action-btn');

  title.innerText = "⭐ 참 잘했어요! ⭐";
  
  if (soloState.isTutorial) {
    bodyText.innerHTML = `네모네모 로직의 신비한 비밀을 한 단계 배웠어요!<br>정말 대단해요. 다른 튜토리얼이나 진짜 퍼즐에도 도전해볼까요?`;
    actionBtn.innerText = "로비로 가기";
    actionBtn.onclick = () => {
      modal.classList.remove('active');
      renderSoloLobby();
      showScreen('solo-lobby-screen');
    };
  } else {
    bodyText.innerHTML = `멋져요! 귀여운 그림 <strong>'${soloState.name}'</strong>을(를) 완성했어요!<br>실수 횟수: ${soloState.errors}번`;
    
    // 다음 레벨 찾기
    const nextId = parseInt(currentLevel) + 1;
    const hasNext = PUZZLES.some(p => p.id === nextId);

    if (hasNext) {
      actionBtn.innerText = "다음 단계 풀기 🚀";
      actionBtn.onclick = () => {
        modal.classList.remove('active');
        const nextPuzzle = PUZZLES.find(p => p.id === nextId);
        startSoloPlay(nextPuzzle, false);
      };
    } else {
      actionBtn.innerText = "우와! 모든 단계 완료! 로비로 가기";
      actionBtn.onclick = () => {
        modal.classList.remove('active');
        renderSoloLobby();
        showScreen('solo-lobby-screen');
      };
    }
  }

  modal.classList.add('active');
}

// 아이들이 좋아할 귀여운 퍼즐 이름 리스트 (동적 생성용)
const puzzleNamesList = [
  "하트 하트", "꼬마 천사", "왕관 별", "비밀의 열쇠", "미로 탐험", "귀여운 유령", "체스 보드",
  "마법 물방울", "기사의 방패", "마법사의 책", "아기새 둥지", "스마일 페이스", "다이아몬드",
  "무당벌레", "꽃게", "나비", "펭귄", "오리", "눈사람", "크리스마스 트리", "사과",
  "바나나", "당근", "사탕", "우산", "돛배", "자동차", "비행기", "우주선", "외계인",
  "와이파이", "텔레비전", "전화기", "연필", "칠판", "축구공", "금메달", "음표", "기타", "피아노",
  "달팽이", "거북이", "소나무", "구름", "해님", "초승달", "꽃병", "나비넥타이", "학교종", "선물상자"
];

function getGeneratedPuzzleName(size, id) {
  const idx = (id - 1) % puzzleNamesList.length;
  return puzzleNamesList[idx] + ` (${id})`;
}

// 6x6 ~ 10x10 크기의 직관적이고 풀기 쉬운 대칭형 픽셀 아트 정답 맵 생성기
function generatePuzzleData(size, id) {
  const grid2D = Array(size).fill(null).map(() => Array(size).fill(0));
  const seed = (id * 17) + (size * 13);
  
  // 대칭 축 결정 (0: 좌우대칭, 1: 상하대칭, 2: 둘 다대칭) - 1학년 눈높이 대칭 설계
  const symmetryType = seed % 3;
  const halfCol = Math.ceil(size / 2);
  const halfRow = Math.ceil(size / 2);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < halfCol; c++) {
      // 간단한 삼각함수 기반 의사 난수 발생기
      const val = Math.sin(seed + r * 7 + c * 3) * 10000;
      const isFilled = (val - Math.floor(val) > 0.45) ? 1 : 0;
      grid2D[r][c] = isFilled;
      
      // 좌우대칭 적용
      if (symmetryType === 0 || symmetryType === 2) {
        grid2D[r][size - 1 - c] = isFilled;
      }
    }
  }

  // 상하대칭 적용
  if (symmetryType === 1 || symmetryType === 2) {
    for (let r = 0; r < halfRow; r++) {
      for (let c = 0; c < size; c++) {
        grid2D[size - 1 - r][c] = grid2D[r][c];
      }
    }
  }

  // 너무 휑하거나 가득 차서 재미없는 패턴 방지
  let fillCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid2D[r][c] === 1) fillCount++;
    }
  }
  
  const total = size * size;
  if (fillCount < total * 0.25 || fillCount > total * 0.75) {
    // 기본형 십자가 또는 사각형 프레임 패턴
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const isCross = (r === Math.floor(size/2) || c === Math.floor(size/2));
        const isBorder = (r === 0 || r === size-1 || c === 0 || c === size-1);
        grid2D[r][c] = (seed % 2 === 0) ? (isCross ? 1 : 0) : (isBorder ? 1 : 0);
      }
    }
  }

  // 문자열 인코딩
  let gridStr = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      gridStr += grid2D[r][c];
    }
  }
  return gridStr;
}

// 200문제와 튜토리얼 4단계 드롭다운 옵션 HTML 생성 헬퍼 (사이즈 필터링 장착)
function buildStageDropdownOptions(size) {
  let html = '';
  
  // 튜토리얼 중 해당 크기와 일치하는 것 추가 (현재 3x3만 제공)
  const tuts = TUTORIAL_PUZZLES.filter(t => t.size === size);
  tuts.forEach((t, i) => {
    html += `<option value="${t.id}">📚 배움 ${i+1}: ${t.name}</option>`;
  });

  // 정식 문제: puzzles.js에 정적 리소스가 있는 3, 4, 5는 그에 어댑팅
  if (size === 3 || size === 4 || size === 5) {
    const items = PUZZLES.filter(p => p.size === size);
    items.forEach(p => {
      html += `<option value="${p.id}">⭐ ${p.id}단계: ${p.name} (${p.size}x${p.size})</option>`;
    });
  } else {
    // 6x6 ~ 10x10의 경우는 200단계에 대해 대칭형 픽셀 무늬를 동적으로 생성
    for (let id = 1; id <= 200; id++) {
      const name = getGeneratedPuzzleName(size, id);
      html += `<option value="g_${size}_${id}">⭐ ${id}단계: ${name} (${size}x${size})</option>`;
    }
  }
  return html;
}

// 개별 플레이어 퍼즐 실시간 변경 함수
function changePlayerPuzzle(playerId, puzzleId) {
  const p = multiPlayers.find(pl => pl.id === playerId);
  if (!p || p.startActive) return;

  let puzzle;
  // 동적 생성 문제 형식 판독: "g_크기_번호"
  if (typeof puzzleId === 'string' && puzzleId.startsWith('g_')) {
    const parts = puzzleId.split('_');
    const sz = parseInt(parts[1]);
    const idxId = parseInt(parts[2]);
    const name = getGeneratedPuzzleName(sz, idxId);
    const grid = generatePuzzleData(sz, idxId);
    
    puzzle = { id: puzzleId, size: sz, name: name, grid: grid };
  } else if (typeof puzzleId === 'string' && puzzleId.startsWith('t')) {
    puzzle = TUTORIAL_PUZZLES.find(t => t.id === puzzleId);
  } else {
    puzzle = PUZZLES.find(l => l.id === parseInt(puzzleId));
  }
  
  if (!puzzle) return;

  p.currentPuzzleId = puzzle.id;
  p.currentSize = puzzle.size;
  p.puzzleObject = puzzle;
  p.board = Array(puzzle.size).fill(null).map(() => Array(puzzle.size).fill(0));
  p.target = parseGridString(puzzle.grid, puzzle.size);
  p.errors = 0;
  p.progress = 0;
  p.finished = false;

  // 에러 및 완료 수치 UI 동기화
  updateErrorDisplay(p.id, 0);
  const progSpan = document.getElementById(`multi-progress-${p.id}`);
  if (progSpan) progSpan.innerText = '0%';

  // 튜토리얼 가이드 말풍선 동적 제어
  const guideBox = document.getElementById(`multi-guide-box-${p.id}`);
  if (guideBox) {
    if (puzzle.guide) {
      guideBox.innerHTML = `💡 ${puzzle.guide}`;
      guideBox.style.display = 'block';
    } else {
      guideBox.style.display = 'none';
    }
  }

  // 보드 렌더링
  renderBoard(`multi-board-area-${p.id}`, p.id, p.board, p.target);
  playSound('x');
}
window.changePlayerPuzzle = changePlayerPuzzle;

let selectedMultiPlayerCount = 2;
let selectedMultiSize = 3;

// === 6인 동시 튜토리얼 ===

const teamTutorialDefaultNames = [
  "분홍 토끼", "파랑 돌고래", "초록 개구리",
  "주황 여우", "보라 고래", "민트 공룡"
];

function setupTeamTutorialLobby() {
  stopTeamTutorialCountdown();
  stopMultiTimer();

  const container = document.getElementById('tutorial-player-names-grid');
  if (container.children.length === 6) return;

  container.innerHTML = '';
  teamTutorialDefaultNames.forEach((name, index) => {
    const label = document.createElement('label');
    label.className = `tutorial-name-card p${index + 1}`;
    label.innerHTML = `
      <span>${index + 1}번</span>
      <input class="tutorial-name-input" type="text" maxlength="12" value="${name}" aria-label="${index + 1}번 플레이어 이름">
    `;
    container.appendChild(label);
  });
}

function startTeamTutorial() {
  initAudio();
  selectedMultiMode = "tutorial";
  teamTutorialState.active = true;
  teamTutorialState.stageIndex = 0;
  teamTutorialState.stageCompleteShown = false;
  completedPlayers = [];

  const nameInputs = document.querySelectorAll('#tutorial-player-names-grid .tutorial-name-input');
  multiPlayers = Array.from(nameInputs).map((input, index) => ({
    id: index + 1,
    name: input.value.trim() || teamTutorialDefaultNames[index],
    board: [],
    target: [],
    activeTool: "pencil",
    errors: 0,
    finished: false,
    finishedTime: null,
    progress: 0,
    startActive: false,
    startTime: null,
    elapsedSeconds: 0,
    currentPuzzleId: null,
    currentSize: 3,
    puzzleObject: null,
    cooldownActive: false,
    tutorialStageIndex: 0,
    hintIndex: -1,
    courseFinished: false,
    autoNextTimeout: null
  }));

  const playScreen = document.getElementById('multi-play-screen');
  playScreen.classList.add('tutorial-mode');
  document.getElementById('team-tutorial-lesson-bar').hidden = false;
  document.getElementById('team-tutorial-bottom-bar').hidden = false;
  document.querySelector('.multi-global-bottom-bar').hidden = true;
  showScreen('multi-play-screen');
  loadTeamTutorialStage(0);
}

function loadTeamTutorialStage(stageIndex) {
  if (!teamTutorialState.active) return;

  const stage = TEAM_TUTORIAL_STAGES[stageIndex];
  if (!stage) return;

  stopTeamTutorialCountdown();
  stopMultiTimer();
  teamTutorialState.stageIndex = stageIndex;
  teamTutorialState.stageCompleteShown = false;

  multiPuzzle = stage;
  multiPlayers.forEach(player => setTeamTutorialPlayerStage(player, stageIndex));

  renderTeamTutorialLesson(stage, stageIndex);
  renderTeamTutorialPanels();
  updateTeamTutorialClassStatus();
  beginTeamTutorialCountdown();
}

function clearTeamTutorialPlayerAdvance(player) {
  if (!player?.autoNextTimeout) return;
  clearTimeout(player.autoNextTimeout);
  player.autoNextTimeout = null;
}

function setTeamTutorialPlayerStage(player, stageIndex) {
  const stage = TEAM_TUTORIAL_STAGES[stageIndex];
  if (!stage) return false;

  clearTeamTutorialPlayerAdvance(player);
  player.tutorialStageIndex = stageIndex;
  player.hintIndex = -1;
  player.board = Array(stage.size).fill(null).map(() => Array(stage.size).fill(0));
  player.target = parseGridString(stage.grid, stage.size);
  player.activeTool = "pencil";
  player.errors = 0;
  player.finished = false;
  player.finishedTime = null;
  player.progress = 0;
  player.startActive = false;
  player.startTime = null;
  player.elapsedSeconds = 0;
  player.currentPuzzleId = stage.id;
  player.currentSize = stage.size;
  player.puzzleObject = stage;
  player.cooldownActive = false;
  return true;
}

function renderTeamTutorialLesson(stage, stageIndex) {
  teamTutorialState.stageIndex = stageIndex;
  document.getElementById('multi-play-title').innerText = `🏫 6명 동시 수업 · ${stage.size} × ${stage.size}`;
  document.getElementById('tutorial-lesson-index').innerText = `${stageIndex + 1} / ${TEAM_TUTORIAL_STAGES.length}`;
  document.getElementById('tutorial-lesson-title').innerText = stage.title;
  document.getElementById('tutorial-lesson-text').innerText = stage.lesson;
  document.getElementById('tutorial-easy-tip').innerText = `💡 ${stage.easyTip}`;
  document.getElementById('tutorial-size-badge').innerText = `${stage.size} × ${stage.size} · ${stage.badge}`;
  document.getElementById('btn-team-tutorial-hint').innerText = '💡 모두 다음 힌트';
}

function renderTeamTutorialPanels() {
  const gridContainer = document.getElementById('multi-play-grid');
  gridContainer.innerHTML = '';
  gridContainer.className = 'multi-play-grid players-6 team-tutorial-grid';

  multiPlayers.forEach(player => renderTeamTutorialPlayerPanel(player));
}

function renderTeamTutorialPlayerPanel(player) {
  const stage = TEAM_TUTORIAL_STAGES[player.tutorialStageIndex];
  const gridContainer = document.getElementById('multi-play-grid');
  let panel = document.getElementById(`player-panel-${player.id}`);
  if (!panel) {
    panel = document.createElement('section');
    panel.id = `player-panel-${player.id}`;
    gridContainer.appendChild(panel);
  }

  panel.className = `player-board-panel tutorial-player-panel tutorial-size-${stage.size} p${player.id}`;
  panel.setAttribute('aria-label', `${player.name}의 ${stage.size} 곱하기 ${stage.size} 튜토리얼 판, ${player.tutorialStageIndex + 1}단계`);
  panel.innerHTML = `
    <div class="player-hud tutorial-player-hud">
      <span class="player-title">${player.id}. ${escapeHtml(player.name)} · ${player.tutorialStageIndex + 1}단계</span>
      <span id="multi-timer-${player.id}" class="player-timer">단계 준비</span>
      <span class="tutorial-error-count">실수 <strong id="multi-errors-${player.id}">0</strong></span>
      <span id="multi-progress-${player.id}" class="player-progress">0%</span>
    </div>
    <div class="tutorial-panel-rule" id="tutorial-panel-rule-${player.id}">
      <span>${player.tutorialStageIndex + 1}/${TEAM_TUTORIAL_STAGES.length} · ${stage.badge}</span>
      <strong>${stage.title}</strong>
      <small id="tutorial-player-tip-${player.id}">${stage.requireX ? '색칠과 X표를 모두 해야 완성이에요.' : '가장 확실한 줄부터 찾아보세요.'}</small>
    </div>
    <div id="multi-board-area-${player.id}" class="board-container tutorial-board-area"></div>
    <div class="tool-selector tutorial-tool-selector">
      <button type="button" class="tool-btn btn-pencil active" id="multi-btn-pencil-${player.id}" aria-label="${escapeHtml(player.name)} 칠하기 도구">✏️ 칠하기</button>
      <button type="button" class="tool-btn btn-x" id="multi-btn-x-${player.id}" aria-label="${escapeHtml(player.name)} X표 도구">❌ X표</button>
      <button type="button" class="tool-btn tutorial-player-hint-btn" id="tutorial-player-hint-${player.id}" aria-label="${escapeHtml(player.name)} 개인 힌트">💡 힌트</button>
    </div>
  `;

  renderBoard(`multi-board-area-${player.id}`, player.id, player.board, player.target);

  const pencilButton = panel.querySelector(`#multi-btn-pencil-${player.id}`);
  const xButton = panel.querySelector(`#multi-btn-x-${player.id}`);
  const hintButton = panel.querySelector(`#tutorial-player-hint-${player.id}`);
  pencilButton.onclick = () => {
    player.activeTool = "pencil";
    pencilButton.classList.add('active');
    xButton.classList.remove('active');
  };
  xButton.onclick = () => {
    player.activeTool = "x";
    pencilButton.classList.remove('active');
    xButton.classList.add('active');
  };
  hintButton.onclick = () => showNextTeamTutorialHintForPlayer(player.id);
}

function beginTeamTutorialCountdown() {
  stopTeamTutorialCountdown();

  const playScreen = document.getElementById('multi-play-screen');
  const overlay = document.createElement('div');
  overlay.id = 'team-tutorial-countdown';
  overlay.className = 'team-tutorial-countdown';
  overlay.innerHTML = `
    <span>6명 모두 손을 준비해요!</span>
    <strong>3</strong>
    <small>같은 순간에 시작합니다</small>
  `;
  playScreen.appendChild(overlay);

  let count = 3;
  teamTutorialState.countdownInterval = setInterval(() => {
    count--;
    const number = overlay.querySelector('strong');
    if (count > 0) {
      number.innerText = count;
      playSound('x');
      return;
    }

    clearInterval(teamTutorialState.countdownInterval);
    teamTutorialState.countdownInterval = null;
    number.innerText = '시작!';
    overlay.classList.add('go');

    const sharedStartTime = new Date().getTime();
    gameStartTime = sharedStartTime;
    multiPlayers.forEach(player => {
      player.startActive = true;
      player.startTime = sharedStartTime;
      const timer = document.getElementById(`multi-timer-${player.id}`);
      if (timer) timer.innerText = '⏱️ 0초';
    });
    startMultiTimer();
    playSound('pencil');

    setTimeout(() => {
      if (overlay.isConnected) overlay.remove();
    }, 650);
  }, 1000);
}

function stopTeamTutorialCountdown() {
  if (teamTutorialState.countdownInterval) {
    clearInterval(teamTutorialState.countdownInterval);
    teamTutorialState.countdownInterval = null;
  }
  const overlay = document.getElementById('team-tutorial-countdown');
  if (overlay) overlay.remove();
}

function clearTeamTutorialHighlights() {
  document.querySelectorAll('.tutorial-highlight').forEach(element => {
    element.classList.remove('tutorial-highlight');
  });
}

function clearTeamTutorialPlayerHighlights(playerId) {
  const area = document.getElementById(`multi-board-area-${playerId}`);
  area?.querySelectorAll('.tutorial-highlight').forEach(element => {
    element.classList.remove('tutorial-highlight');
  });
}

function showNextTeamTutorialHintForPlayer(playerId, playFeedback = true) {
  if (!teamTutorialState.active) return;
  const player = multiPlayers.find(item => item.id === playerId);
  if (!player || player.finished || player.courseFinished) return;

  const stage = TEAM_TUTORIAL_STAGES[player.tutorialStageIndex];
  if (!stage?.hints.length) return;

  clearTeamTutorialPlayerHighlights(playerId);
  player.hintIndex = (player.hintIndex + 1) % stage.hints.length;
  const hint = stage.hints[player.hintIndex];
  const area = document.getElementById(`multi-board-area-${player.id}`);
  if (!area) return;

  (hint.rows || []).forEach(row => {
    area.querySelector(`.row-header-cell[data-row="${row}"]`)?.classList.add('tutorial-highlight');
  });
  (hint.cols || []).forEach(col => {
    area.querySelector(`.col-header-cell[data-col="${col}"]`)?.classList.add('tutorial-highlight');
  });
  (hint.cells || []).forEach(([row, col]) => {
    area.querySelector(`.nono-cell[data-r="${row}"][data-c="${col}"]`)?.classList.add('tutorial-highlight');
  });

  const tip = document.getElementById(`tutorial-player-tip-${player.id}`);
  if (tip) tip.innerText = `👉 ${hint.text}`;
  const hintButton = document.getElementById(`tutorial-player-hint-${player.id}`);
  if (hintButton) hintButton.innerText = `💡 ${player.hintIndex + 1}/${stage.hints.length}`;
  if (playFeedback) playSound('x');
}

function showNextTeamTutorialHint() {
  if (!teamTutorialState.active) return;
  multiPlayers.forEach(player => showNextTeamTutorialHintForPlayer(player.id, false));
  document.getElementById('tutorial-easy-tip').innerText = '👉 각자 풀고 있는 단계에 맞는 다음 힌트를 표시했어요.';
  playSound('x');
}

// 색칠은 모두 정답인데 X표가 남은 경우, 남은 빈칸을 반짝여서 짚어준다 (requireX 단계 전용)
function showTeamTutorialMissingXFeedback(player) {
  const area = document.getElementById(`multi-board-area-${player.id}`);
  if (!area) return;

  clearTeamTutorialPlayerHighlights(player.id);
  let missing = 0;
  for (let r = 0; r < player.board.length; r++) {
    for (let c = 0; c < player.board.length; c++) {
      if (player.target[r][c] === 0 && player.board[r][c] !== 2) {
        missing++;
        area.querySelector(`.nono-cell[data-r="${r}"][data-c="${c}"]`)?.classList.add('tutorial-highlight');
      }
    }
  }

  const tip = document.getElementById(`tutorial-player-tip-${player.id}`);
  if (tip && missing > 0) {
    tip.innerText = `🎨 색칠 완성! 반짝이는 빈칸 ${missing}개에 ❌를 하면 다음 단계로 가요.`;
  }
}

function finishTeamTutorialPlayer(player) {
  if (player.finished) return;
  player.finished = true;
  player.startActive = false;
  player.finishedTime = new Date().getTime();
  player.elapsedSeconds = player.startTime
    ? Math.max(0, Math.floor((player.finishedTime - player.startTime) / 1000))
    : 0;
  player.progress = 100;

  const isLastStage = player.tutorialStageIndex === TEAM_TUTORIAL_STAGES.length - 1;
  player.courseFinished = isLastStage;

  const panel = document.getElementById(`player-panel-${player.id}`);
  const progress = document.getElementById(`multi-progress-${player.id}`);
  const timer = document.getElementById(`multi-timer-${player.id}`);
  if (progress) progress.innerText = '100%';
  if (timer) timer.innerText = `✅ ${player.elapsedSeconds}초`;
  if (panel) {
    panel.classList.add('tutorial-finished');
    const badge = document.createElement('div');
    badge.className = 'tutorial-finished-badge';
    badge.innerHTML = isLastStage
      ? '<strong>8단계 모두 완료!</strong><span>로직 박사가 되었어요 🏆</span>'
      : `<strong>${player.tutorialStageIndex + 1}단계 완성!</strong><span>2초 뒤 내 다음 단계로 가요</span><button type="button" class="tutorial-next-btn">바로 다음 공부 →</button>`;
    panel.appendChild(badge);
    badge.querySelector('.tutorial-next-btn')?.addEventListener('click', () => advanceTeamTutorialPlayer(player.id));
  }
  playSound('clear');
  updateTeamTutorialClassStatus();

  if (!isLastStage) {
    player.autoNextTimeout = setTimeout(() => advanceTeamTutorialPlayer(player.id), 2000);
  }

  if (multiPlayers.every(item => item.courseFinished) && !teamTutorialState.stageCompleteShown) {
    teamTutorialState.stageCompleteShown = true;
    stopMultiTimer();
    startConfetti();
    playSound('win');
    setTimeout(() => {
      if (teamTutorialState.active) showTeamTutorialCourseComplete();
    }, 500);
  }
}

function advanceTeamTutorialPlayer(playerId) {
  if (!teamTutorialState.active) return;
  const player = multiPlayers.find(item => item.id === playerId);
  if (!player || player.courseFinished || !player.finished) return;

  const nextStageIndex = player.tutorialStageIndex + 1;
  if (!setTeamTutorialPlayerStage(player, nextStageIndex)) return;

  renderTeamTutorialPlayerPanel(player);
  player.startActive = true;
  player.startTime = new Date().getTime();
  const timer = document.getElementById(`multi-timer-${player.id}`);
  if (timer) timer.innerText = '⏱️ 0초';
  updateTeamTutorialClassStatus();
  playSound('pencil');
}

function updateTeamTutorialClassStatus() {
  const completed = multiPlayers.filter(player => player.courseFinished).length;
  const moving = multiPlayers.filter(player => player.finished && !player.courseFinished).length;
  const status = document.getElementById('tutorial-complete-count');
  if (status) status.innerText = `과정 완료 ${completed} / 6${moving ? ` · 이동 중 ${moving}명` : ''}`;

  const activePlayers = multiPlayers.filter(player => !player.courseFinished);
  if (!activePlayers.length) {
    document.getElementById('tutorial-lesson-index').innerText = '8 / 8';
    document.getElementById('tutorial-lesson-title').innerText = '6명 모두 개별 과정 완료!';
    document.getElementById('tutorial-lesson-text').innerText = '각자 자기 속도로 8단계를 모두 끝냈어요.';
    document.getElementById('tutorial-easy-tip').innerText = '🏆 숫자, X표, 교차, 겹치는 칸 찾기를 모두 배웠어요.';
    document.getElementById('tutorial-size-badge').innerText = '개인별 8단계 완료';
    return;
  }

  const stageIndexes = [...new Set(activePlayers.map(player => player.tutorialStageIndex))];
  if (stageIndexes.length === 1) {
    const stageIndex = stageIndexes[0];
    renderTeamTutorialLesson(TEAM_TUTORIAL_STAGES[stageIndex], stageIndex);
    return;
  }

  const stageCounts = activePlayers.reduce((counts, player) => {
    const key = player.tutorialStageIndex + 1;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const distribution = Object.entries(stageCounts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([stage, count]) => `${stage}단계 ${count}명`)
    .join(' · ');

  document.getElementById('multi-play-title').innerText = '🏫 6명 함께 배우기 · 각자 속도로 진행 중';
  document.getElementById('tutorial-lesson-index').innerText = '개별 진행';
  document.getElementById('tutorial-lesson-title').innerText = '서로 다른 단계를 동시에 공부해요';
  document.getElementById('tutorial-lesson-text').innerText = distribution;
  document.getElementById('tutorial-easy-tip').innerText = '💡 자기 판의 힌트 버튼을 누르면 현재 문제에 맞는 쉬운 풀이가 나와요.';
  document.getElementById('tutorial-size-badge').innerText = '3 × 3 ~ 6 × 6 · 개인별';
  document.getElementById('btn-team-tutorial-hint').innerText = '💡 모두 다음 힌트';
}

function showTeamTutorialCourseComplete() {
  const modal = document.getElementById('clear-modal');
  const title = document.getElementById('modal-title');
  const bodyText = document.getElementById('modal-body');
  const actionButton = document.getElementById('modal-action-btn');

  title.innerText = '🏆 6명 모두 로직 박사!';
  bodyText.innerHTML = `6명이 각자 자기 속도로 숫자 읽기, X표, 묶음 사이 띄우기, 가로세로 교차, 겹치는 칸 찾기까지 모두 배웠어요.<br><strong>막히면 큰 숫자와 0부터 찾는 것</strong>을 기억하세요!`;
  actionButton.innerText = '수업 준비 화면으로';
  actionButton.onclick = () => {
    modal.classList.remove('active');
    try {
      localStorage.setItem('nemonemo_team_tutorial_complete', 'true');
    } catch (error) {
      console.warn('튜토리얼 완료 기록 저장 실패:', error);
    }
    leaveTeamTutorial();
  };
  modal.classList.add('active');
}

function leaveTeamTutorial() {
  stopTeamTutorialCountdown();
  stopMultiTimer();
  clearTeamTutorialHighlights();
  multiPlayers.forEach(clearTeamTutorialPlayerAdvance);
  teamTutorialState.active = false;
  selectedMultiMode = "normal";
  activePointerDowns = {};
  dragStartValues = {};
  document.getElementById('clear-modal').classList.remove('active');
  document.getElementById('multi-play-screen').classList.remove('tutorial-mode');
  document.getElementById('team-tutorial-lesson-bar').hidden = true;
  document.getElementById('team-tutorial-bottom-bar').hidden = true;
  document.querySelector('.multi-global-bottom-bar').hidden = false;
  showScreen('team-tutorial-lobby-screen');
}

// === 멀티플레이 로비 (설정) 구현 ===
function setupMultiLobbyForm() {
  selectedMultiMode = "normal";
  selectedMultiPlayerCount = 2;
  selectedMultiSize = 3;
  
  // 플레이어 수 버튼들 탭
  const btnGroup = document.getElementById('multi-player-count-btns');
  btnGroup.innerHTML = '';
  const counts = [2, 3, 4, 5, 6];
  counts.forEach(i => {
    const btn = document.createElement('button');
    btn.className = `p-count-btn ${i === 2 ? 'active' : ''}`;
    btn.innerText = `${i}명`;
    btn.type = 'button';
    btn.onclick = () => {
      document.querySelectorAll('.p-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMultiPlayerCount = i;
      updatePlayerNameInputs(i);
      playSound('x');
    };
    btnGroup.appendChild(btn);
  });

  // 플레이어 이름 입력 필드들 생성
  updatePlayerNameInputs(2);

  // 시작 버튼 바인딩
  document.getElementById('multi-setup-form').onsubmit = (e) => {
    e.preventDefault();
    selectedMultiSize = parseInt(document.getElementById('multi-size-select').value) || 3;
    startMultiPlay();
  };
}

// 참가인원 수에 따라 이름 입력 폼 활성화/비활성화
function updatePlayerNameInputs(count) {
  const container = document.getElementById('multi-player-names-grid');
  container.innerHTML = '';

  const defaultNames = ["초록 개구리", "노랑 병아리", "하늘 토끼", "빨간 무당벌레", "보라 고래", "민트 공룡"];

  for (let i = 1; i <= count; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'player-name-input';
    input.placeholder = `플레이어 ${i} 이름`;
    input.value = defaultNames[i - 1] || `플레이어 ${i}`;
    input.required = true;
    container.appendChild(input);
  }
}

// === 멀티플레이 게임 작동 ===
function startMultiPlay() {
  selectedMultiMode = "normal";
  teamTutorialState.active = false;
  stopTeamTutorialCountdown();
  const nameInputs = document.querySelectorAll('#multi-player-names-grid .player-name-input');
  
  // 기본 디폴트 퍼즐: 선택한 selectedMultiSize 에 어댑팅하여 1단계 마련
  let defaultPuzzle;
  if (selectedMultiSize === 3 || selectedMultiSize === 4 || selectedMultiSize === 5) {
    defaultPuzzle = PUZZLES.find(p => p.size === selectedMultiSize);
  } else {
    defaultPuzzle = {
      id: `g_${selectedMultiSize}_1`,
      size: selectedMultiSize,
      name: getGeneratedPuzzleName(selectedMultiSize, 1),
      grid: generatePuzzleData(selectedMultiSize, 1)
    };
  }

  multiPuzzle = defaultPuzzle;
  completedPlayers = [];

  // 멀티플레이어 배열 빌드 (각자 독립적 퍼즐 객체를 가짐)
  multiPlayers = [];
  nameInputs.forEach((input, index) => {
    const pId = index + 1;
    multiPlayers.push({
      id: pId,
      name: input.value.trim() || `플레이어 ${pId}`,
      board: Array(defaultPuzzle.size).fill(null).map(() => Array(defaultPuzzle.size).fill(0)),
      target: parseGridString(defaultPuzzle.grid, defaultPuzzle.size),
      activeTool: "pencil",
      errors: 0,
      finished: false,
      finishedTime: null,
      progress: 0,
      startActive: false,
      startTime: null,
      elapsedSeconds: 0,
      currentPuzzleId: defaultPuzzle.id,
      currentSize: defaultPuzzle.size,
      puzzleObject: defaultPuzzle
    });
  });

  // UI 세팅
  document.getElementById('multi-play-title').innerText = "🏫 네모네모 로직 교실";
  const playScreen = document.getElementById('multi-play-screen');
  playScreen.classList.remove('tutorial-mode');
  document.getElementById('team-tutorial-lesson-bar').hidden = true;
  document.getElementById('team-tutorial-bottom-bar').hidden = true;
  document.querySelector('.multi-global-bottom-bar').hidden = false;
  const gridContainer = document.getElementById('multi-play-grid');
  gridContainer.innerHTML = '';
  
  // 격자 배치 클래스 동적 주입
  gridContainer.className = `multi-play-grid players-${multiPlayers.length}`;

  // 각 플레이어별 패널 동적 생성 및 보드 렌더링
  multiPlayers.forEach(p => {
    const panel = document.createElement('div');
    panel.id = `player-panel-${p.id}`;
    panel.className = `player-board-panel p${p.id}`;

    // 내부 HTML 틀 생성
    panel.innerHTML = `
      <div class="player-hud">
        <span class="player-title">👤 ${escapeHtml(p.name)}</span>
        <span id="multi-timer-${p.id}" class="player-timer">⏱️ 대기</span>
        <span style="font-size:0.9rem;color:#e11d48;">❌ <span id="multi-errors-${p.id}">0</span></span>
        <span id="multi-progress-${p.id}" class="player-progress">0%</span>
      </div>
      <div class="guide-box" id="multi-guide-box-${p.id}" style="margin-bottom: 4px; font-size: 0.85rem; padding: 6px; width: 100%; border-style: dashed; border-width: 2px; display: none; line-height: 1.3;"></div>
      <div id="multi-board-area-${p.id}" class="board-container" style="flex-grow:1; margin-bottom: 0px;"></div>
      <div class="tool-selector" style="margin-top: 4px; margin-bottom: 4px;">
        <button type="button" class="tool-btn btn-pencil active" id="multi-btn-pencil-${p.id}">✏️ 칠하기</button>
        <button type="button" class="tool-btn btn-x" id="multi-btn-x-${p.id}">❌ X표</button>
      </div>
      <!-- 개별 시작 오버레이 - 문제 고르기 드롭다운 추가 -->
      <div class="start-overlay" id="start-overlay-${p.id}">
        <div class="start-overlay-title">문제를 골라보세요!</div>
        <select id="stage-select-${p.id}" class="player-name-input" style="width: 85%; font-weight: bold; margin-bottom: 12px; font-size: 0.9rem; text-align: center;" onchange="changePlayerPuzzle(${p.id}, this.value)">
          ${buildStageDropdownOptions(p.currentSize)}
        </select>
        <button type="button" class="start-play-btn" onclick="activateMultiPlayer(${p.id})">▶️ 시작!</button>
      </div>
    `;

    gridContainer.appendChild(panel);

    // 보드 렌더링
    renderBoard(`multi-board-area-${p.id}`, p.id, p.board, p.target);

    // 도구 전환 이벤트 연결
    const pBtnPencil = panel.querySelector(`#multi-btn-pencil-${p.id}`);
    const pBtnX = panel.querySelector(`#multi-btn-x-${p.id}`);

    pBtnPencil.onclick = () => {
      p.activeTool = "pencil";
      pBtnPencil.classList.add('active');
      pBtnX.classList.remove('active');
    };
    pBtnX.onclick = () => {
      p.activeTool = "x";
      pBtnPencil.classList.remove('active');
      pBtnX.classList.add('active');
    };
  });

  // 타이머 작동
  gameStartTime = new Date().getTime();
  startMultiTimer();

  showScreen('multi-play-screen');
}

// 멀티플레이 타이머 제어
function startMultiTimer() {
  stopMultiTimer();
  const timerSpan = document.getElementById('multi-timer-val');
  timerSpan.innerText = "00:00";

  multiTimerInterval = setInterval(() => {
    const now = new Date().getTime();
    const diff = Math.floor((now - gameStartTime) / 1000);
    const min = String(Math.floor(diff / 60)).padStart(2, '0');
    const sec = String(diff % 60).padStart(2, '0');
    timerSpan.innerText = `${min}:${sec}`;

    // 개별 플레이어 타이머 갱신 (시작한 사람만)
    multiPlayers.forEach(p => {
      if (p.startActive && !p.finished) {
        const elapsed = Math.floor((now - p.startTime) / 1000);
        p.elapsedSeconds = elapsed;
        
        const pTimerSpan = document.getElementById(`multi-timer-${p.id}`);
        if (pTimerSpan) {
          pTimerSpan.innerText = `⏱️ ${elapsed}초`;
        }
      }
    });
  }, 1000);
}

// 개별 플레이어 시작 활성화 함수
function activateMultiPlayer(playerId) {
  const p = multiPlayers.find(pl => pl.id === playerId);
  if (!p || p.startActive) return;

  p.startActive = true;
  p.startTime = new Date().getTime();
  
  // 오버레이 제거 (투명해진 후 삭제)
  const overlay = document.getElementById(`start-overlay-${playerId}`);
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
  }
  
  // 개별 타이머 초기화 표시
  const timerSpan = document.getElementById(`multi-timer-${playerId}`);
  if (timerSpan) {
    timerSpan.innerText = `⏱️ 0초`;
  }
  
  playSound('pencil');
}
window.activateMultiPlayer = activateMultiPlayer;

function stopMultiTimer() {
  if (multiTimerInterval) {
    clearInterval(multiTimerInterval);
    multiTimerInterval = null;
  }
}

// 모든 인원이 완료했거나 종료 처리 시 결과창 노출
function endMultiGame() {
  stopMultiTimer();
  playSound('win');
  startConfetti();

  // 순위별 랭킹 팝업 구성
  const modal = document.getElementById('clear-modal');
  const title = document.getElementById('modal-title');
  const bodyText = document.getElementById('modal-body');
  const actionBtn = document.getElementById('modal-action-btn');

  title.innerText = "🏁 대결 종료! 🏁";

  // 정렬: 완주자 순위 -> 완료 시간 기준 오름차순, 미완주자는 뒤로
  const sortedPlayers = [...multiPlayers].sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) {
      return a.elapsedSeconds - b.elapsedSeconds; // 개별 플레이 시간으로 랭킹 산정!
    }
    // 미완주자끼리는 진행률 내림차순
    return b.progress - a.progress;
  });

  let resultsHtml = `<div style="text-align:left; margin: 15px auto; max-width: 320px;">`;
  sortedPlayers.forEach((p, idx) => {
    const medal = (idx === 0) ? '🥇' : (idx === 1) ? '🥈' : (idx === 2) ? '🥉' : '👤';
    let status = '';
    
    if (p.finished) {
      status = `<span style="color:#10b981;font-weight:bold;">${p.elapsedSeconds}초 골인!</span>`;
    } else if (p.startActive) {
      status = `<span style="color:#ef4444;">미완성 (${p.progress}%)</span>`;
    } else {
      status = `<span style="color:#94a3b8;">시작 안 함</span>`;
    }
    
    resultsHtml += `
      <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:1.15rem;">
        <span>${medal} ${idx + 1}등: <strong>${p.name}</strong></span>
        <span>${status} (실수:${p.errors}회)</span>
      </div>
    `;
  });
  resultsHtml += `</div>`;

  bodyText.innerHTML = `모두 고생했어요! 오늘의 챔피언은 누구일까요? 아래 랭킹을 확인해 봐요!<br>${resultsHtml}`;
  actionBtn.innerText = "대결 설정으로 돌아가기";
  
  actionBtn.onclick = () => {
    modal.classList.remove('active');
    setupMultiLobbyForm();
    showScreen('multi-lobby-screen');
  };

  modal.classList.add('active');
}

// 다음 단계 자동으로 시작되게 처리하는 함수
function autoNextPlayerPuzzle(playerId, nextPuzzleId) {
  const p = multiPlayers.find(pl => pl.id === playerId);
  if (!p) return;

  if (p.autoNextInterval) {
    clearInterval(p.autoNextInterval);
    p.autoNextInterval = null;
  }

  // 개별 완료 오버레이 제거
  const clearOverlay = document.getElementById(`clear-overlay-${playerId}`);
  if (clearOverlay) clearOverlay.remove();
  
  // 플레이어 완료 패널 스타일 해제
  const panel = document.getElementById(`player-panel-${playerId}`);
  if (panel) panel.classList.remove('finished');

  // 1. startActive가 false인 상태에서 changePlayerPuzzle을 수행하여 새 퍼즐 로드
  p.startActive = false;
  changePlayerPuzzle(playerId, nextPuzzleId);

  // 2. 오버레이 없이 바로 활성화 상태로 전환
  p.startActive = true;
  p.elapsedSeconds = 0;
  p.startTime = new Date().getTime();
  p.finished = false;
  p.finishedTime = null;
  p.errors = 0;
  p.progress = 0;

  // 에러 카운터 UI 초기화
  updateErrorDisplay(playerId, 0);
  const progSpan = document.getElementById(`multi-progress-${playerId}`);
  if (progSpan) progSpan.innerText = '0%';

  // 개별 타이머 초기화 표시
  const timerSpan = document.getElementById(`multi-timer-${playerId}`);
  if (timerSpan) {
    timerSpan.innerText = `⏱️ 0초`;
  }
  
  playSound('pencil');
}
window.autoNextPlayerPuzzle = autoNextPlayerPuzzle;

// 다음 단계 풀기 버튼 클릭 시 동작
function nextPlayerPuzzle(playerId, nextPuzzleId) {
  const p = multiPlayers.find(pl => pl.id === playerId);
  if (p && p.autoNextInterval) {
    clearInterval(p.autoNextInterval);
    p.autoNextInterval = null;
  }

  // 개별 완료 오버레이 제거
  const clearOverlay = document.getElementById(`clear-overlay-${playerId}`);
  if (clearOverlay) clearOverlay.remove();
  
  // 플레이어 완료 패널 스타일 해제
  const panel = document.getElementById(`player-panel-${playerId}`);
  if (panel) panel.classList.remove('finished');

  // 대기 오버레이 복원
  restoreStartOverlay(playerId, nextPuzzleId);
}
window.nextPlayerPuzzle = nextPlayerPuzzle;

// 단계 변경 버튼 클릭 시 동작
function resetPlayerToLobby(playerId) {
  const p = multiPlayers.find(pl => pl.id === playerId);
  if (p && p.autoNextInterval) {
    clearInterval(p.autoNextInterval);
    p.autoNextInterval = null;
  }

  // 개별 완료 오버레이 제거
  const clearOverlay = document.getElementById(`clear-overlay-${playerId}`);
  if (clearOverlay) clearOverlay.remove();

  // 플레이어 완료 패널 스타일 해제
  const panel = document.getElementById(`player-panel-${playerId}`);
  if (panel) panel.classList.remove('finished');

  // 대기 오버레이 복원 (현재 단계 그대로 드롭다운 유지)
  restoreStartOverlay(playerId, p.currentPuzzleId);
}
window.resetPlayerToLobby = resetPlayerToLobby;

// 시작 오버레이 복원 공통 함수
function restoreStartOverlay(playerId, puzzleId) {
  const p = multiPlayers.find(pl => pl.id === playerId);
  if (!p) return;

  p.startActive = false;
  p.elapsedSeconds = 0;
  p.startTime = null;
  p.finished = false;
  p.finishedTime = null;
  p.errors = 0;
  p.progress = 0;
  
  // 에러 카운터 UI 초기화
  updateErrorDisplay(playerId, 0);
  const progSpan = document.getElementById(`multi-progress-${playerId}`);
  if (progSpan) progSpan.innerText = '0%';

  // 기존 타이머 대기로 복원
  const timerSpan = document.getElementById(`multi-timer-${playerId}`);
  if (timerSpan) timerSpan.innerText = `⏱️ 대기`;

  // 오버레이 재생성 후 추가
  const panel = document.getElementById(`player-panel-${playerId}`);
  if (panel) {
    const existing = document.getElementById(`start-overlay-${playerId}`);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'start-overlay';
    overlay.id = `start-overlay-${playerId}`;
    overlay.innerHTML = `
      <div class="start-overlay-title">문제를 골라보세요!</div>
      <select id="stage-select-${p.id}" class="player-name-input" style="width: 85%; font-weight: bold; margin-bottom: 12px; font-size: 0.9rem; text-align: center;" onchange="changePlayerPuzzle(${p.id}, this.value)">
        ${buildStageDropdownOptions(p.currentSize)}
      </select>
      <button type="button" class="start-play-btn" onclick="activateMultiPlayer(${p.id})">▶️ 시작!</button>
    `;
    panel.appendChild(overlay);

    // 새 퍼즐로 갱신 적용
    changePlayerPuzzle(playerId, puzzleId);
    
    // 드롭다운 현재 선택값 셋팅
    const select = document.getElementById(`stage-select-${p.id}`);
    if (select) select.value = puzzleId;
  }
}

// 3회 실수 누적 시 3초간 조작 잠금 패널티 오버레이 표시
function triggerCooldownPenalty(playerId, state) {
  if (state.cooldownActive) return;
  state.cooldownActive = true;
  
  // 드래그/터치 락 상태 강제 해제
  if (playerId === 'solo') {
    isPointerDown = false;
    soloPointerId = null;
  } else {
    delete activePointerDowns[playerId];
  }

  let targetContainer;
  let overlayId;
  if (playerId === 'solo') {
    targetContainer = document.getElementById('solo-board-area');
    overlayId = 'solo-cooldown-overlay';
  } else {
    targetContainer = document.getElementById(`player-panel-${playerId}`);
    overlayId = `cooldown-overlay-${playerId}`;
  }

  if (!targetContainer) return;

  // 쿨다운 오버레이 생성
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = 'clear-overlay';
  overlay.style.background = 'rgba(254, 226, 226, 0.98)';
  overlay.style.borderColor = '#ef4444';
  overlay.style.borderWidth = '3px';
  overlay.style.borderStyle = 'solid';
  
  overlay.innerHTML = `
    <div class="clear-overlay-title" style="color: #b91c1c; font-size: clamp(1rem, 1.8vw, 1.4rem);">앗! 틀렸어요! 🧠</div>
    <div class="clear-overlay-stats" style="color: #7f1d1d; margin-bottom: 8px; font-size: clamp(0.78rem, 1.1vw, 0.95rem); line-height: 1.4;">
      아무거나 마구 누르면 안 돼요!<br>
      숫자를 보고 <strong>차분하게 생각하는 시간</strong>
    </div>
    <div id="cooldown-timer-${playerId}" style="font-size: clamp(1.8rem, 3vw, 2.5rem); font-weight: bold; color: #ef4444; margin-bottom: 5px;">3</div>
    <p style="color: #991b1b; font-size: 0.8rem; margin: 0;">생각한 뒤 다시 풀어볼까요?</p>
  `;
  
  targetContainer.appendChild(overlay);

  // 3초 카운트다운
  let timeLeft = 3;
  const interval = setInterval(() => {
    timeLeft--;
    const timerText = document.getElementById(`cooldown-timer-${playerId}`);
    if (timerText) {
      timerText.innerText = timeLeft;
    }
    if (timeLeft <= 0) {
      clearInterval(interval);
      overlay.remove();
      state.cooldownActive = false;
    }
  }, 1000);
}
