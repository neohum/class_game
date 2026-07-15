import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { TEAM_TUTORIAL_STAGES } = require('../public/games/nemonemo-logic/puzzles.js');

const html = await readFile(new URL('../public/games/nemonemo-logic/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/games/nemonemo-logic/script.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../public/games/nemonemo-logic/style.css', import.meta.url), 'utf8');

const lineClues = line => {
  const clues = [];
  let count = 0;
  line.forEach(value => {
    if (value === 1) {
      count++;
    } else if (count > 0) {
      clues.push(count);
      count = 0;
    }
  });
  if (count > 0) clues.push(count);
  return clues.length > 0 ? clues : [0];
};

const sameClues = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const matchingLines = (size, clues) => {
  const candidates = [];
  for (let mask = 0; mask < 2 ** size; mask++) {
    const line = Array.from({ length: size }, (_, index) => (mask >> (size - 1 - index)) & 1);
    if (sameClues(lineClues(line), clues)) candidates.push(line);
  }
  return candidates;
};

const countSolutions = stage => {
  const size = stage.size;
  const target = Array.from({ length: size }, (_, row) =>
    [...stage.grid.slice(row * size, (row + 1) * size)].map(Number)
  );
  const rowCandidates = target.map(row => matchingLines(size, lineClues(row)));
  const colCandidates = Array.from({ length: size }, (_, col) =>
    matchingLines(size, lineClues(target.map(row => row[col])))
  );
  const chosenRows = [];
  let solutions = 0;

  const search = rowIndex => {
    if (solutions > 1) return;
    if (rowIndex === size) {
      solutions++;
      return;
    }

    rowCandidates[rowIndex].forEach(row => {
      if (solutions > 1) return;
      chosenRows.push(row);
      const prefixIsPossible = colCandidates.every((candidates, col) => {
        const prefix = chosenRows.map(chosen => chosen[col]);
        return candidates.some(candidate => prefix.every((value, index) => candidate[index] === value));
      });
      if (prefixIsPossible) search(rowIndex + 1);
      chosenRows.pop();
    });
  };

  search(0);
  return solutions;
};

assert.equal(TEAM_TUTORIAL_STAGES.length, 8, '튜토리얼은 8단계여야 합니다.');
assert.deepEqual(
  TEAM_TUTORIAL_STAGES.map(stage => stage.size),
  [3, 3, 4, 4, 5, 5, 6, 6],
  '3·4·5·6칸을 각각 두 단계씩 배워야 합니다.'
);

TEAM_TUTORIAL_STAGES.forEach(stage => {
  assert.match(stage.grid, /^[01]+$/, `${stage.id}: 정답은 0과 1로만 구성되어야 합니다.`);
  assert.equal(stage.grid.length, stage.size ** 2, `${stage.id}: 정답 칸 수가 맞지 않습니다.`);
  assert.ok(stage.grid.includes('1') && stage.grid.includes('0'), `${stage.id}: 색칠 칸과 빈칸이 모두 있어야 합니다.`);
  assert.equal(stage.hints.length, 3, `${stage.id}: 쉬운 풀이 힌트는 세 단계여야 합니다.`);
  stage.hints.forEach(hint => {
    (hint.cells || []).forEach(([row, col]) => {
      assert.ok(row >= 0 && row < stage.size && col >= 0 && col < stage.size, `${stage.id}: 힌트 좌표가 판 밖입니다.`);
    });
  });
  assert.equal(countSolutions(stage), 1, `${stage.id}: 숫자 힌트만으로 답이 하나여야 합니다.`);
});

[
  'btn-goto-team-tutorial',
  'team-tutorial-lobby-screen',
  'tutorial-player-names-grid',
  'btn-start-team-tutorial',
  'team-tutorial-lesson-bar',
  'team-tutorial-bottom-bar'
].forEach(id => assert.ok(html.includes(`id="${id}"`), `index.html에 #${id}가 필요합니다.`));

assert.match(script, /sharedStartTime/, '6명의 시작 시각은 하나의 타임스탬프를 공유해야 합니다.');
assert.match(script, /tutorialStageIndex:\s*0/, '각 플레이어가 자기 튜토리얼 단계를 가져야 합니다.');
assert.match(script, /TEAM_TUTORIAL_STAGES\[state\.tutorialStageIndex\]/, '정답 판정은 플레이어의 현재 단계를 사용해야 합니다.');
assert.match(script, /function advanceTeamTutorialPlayer\(playerId\)/, '완료한 플레이어만 다음 단계로 이동할 수 있어야 합니다.');
assert.match(script, /autoNextTimeout = setTimeout\(\(\) => advanceTeamTutorialPlayer\(player\.id\)/, '완료 후 개인별 자동 진행이 필요합니다.');
assert.match(script, /multiPlayers\.every\(item => item\.courseFinished\)/, '전체 수업 완료는 6명의 개인 과정을 기준으로 확인해야 합니다.');
assert.match(
  style,
  /\.tutorial-mode \.multi-play-grid\.team-tutorial-grid\.players-6\s*\{[^}]*grid-template-columns:\s*repeat\(6,/s,
  '6인 튜토리얼 판은 한 줄 6열이어야 합니다.'
);
assert.match(
  style,
  /\.multi-play-grid\.players-5\s*\{[^}]*grid-template-columns:\s*repeat\(5,[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s,
  '일반 5인 게임 판은 한 줄 5열이어야 합니다.'
);
assert.match(
  style,
  /\.multi-play-grid\.players-6\s*\{[^}]*grid-template-columns:\s*repeat\(6,[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s,
  '일반 6인 게임 판은 한 줄 6열이어야 합니다.'
);

console.log('네모네모 로직 검증 완료: 6명 개인별 진행, 모든 인원 가로 배열, 8단계 고유 해답, 동시 시작 UI');
