// scripts/metrics/rules/react-doctor-rules.ts
// React Doctor AST Rule Engine — Detects AI-agent React anti-patterns:
// 1. Unnecessary useEffect / derived state syncing (RD-EFFECT-DERIVED-STATE)
// 2. Missing dependency arrays or omitted reactive deps in hooks (RD-EFFECT-MISSING-DEPS)
// 3. Inline object / array / function creation in JSX re-renders (RD-INLINE-OBJECT-IN-JSX, RD-INLINE-FUNCTION-IN-MAP)
// 4. Missing key in list rendering .map() (RD-MISSING-KEY)
// 5. ARIA and accessibility defects in JSX (RD-ARIA-IMG-ALT, RD-ARIA-BUTTON-NAME, RD-ARIA-INTERACTIVE-ROLE, RD-ARIA-INPUT-LABEL)

import ts from "typescript";
import type { Node, SourceFile } from "typescript";
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { resolve, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ReactDoctorSeverity = {
  Fatal: "fatal",
  Warn: "warn",
  Info: "info",
} as const;
export type ReactDoctorSeverity = typeof ReactDoctorSeverity[keyof typeof ReactDoctorSeverity];

export interface ReactDoctorViolation {
  ruleId: string;
  ruleName: string;
  severity: ReactDoctorSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
  snippet?: string;
  remediation: string;
  details?: Record<string, unknown>;
}

export interface ReactDoctorAnalysisResult {
  file: string;
  passed: boolean;
  score: number;
  totalViolations: number;
  fatalCount: number;
  warnCount: number;
  infoCount: number;
  violations: ReactDoctorViolation[];
  summary: string;
}

export interface ReactDoctorGateResult {
  passed: boolean;
  score: number;
  totalFiles: number;
  filesWithViolations: number;
  totalViolations: number;
  fatalCount: number;
  warnCount: number;
  infoCount: number;
  results: ReactDoctorAnalysisResult[];
  violations: ReactDoctorViolation[];
}

const GLOBAL_BUILTINS = new Set([
  "window", "document", "console", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "fetch", "Math", "Date", "JSON",
  "Object", "Array", "String", "Number", "Boolean", "RegExp", "Error",
  "Promise", "navigator", "localStorage", "sessionStorage", "location",
  "history", "requestAnimationFrame", "cancelAnimationFrame", "alert",
  "confirm", "prompt", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
  "undefined", "NaN", "Infinity", "null", "true", "false",
]);

interface ComponentScope {
  name: string;
  props: Set<string>;
  stateGetters: Set<string>;
  stateSetters: Set<string>;
  refs: Set<string>;
  locals: Set<string>;
}

/**
 * Extract component scope information: props, useState getters/setters, useRef, and locals.
 */
function extractComponentScope(componentNode: Node, sourceFile: SourceFile): ComponentScope {
  const scope: ComponentScope = {
    name: "AnonymousComponent",
    props: new Set(),
    stateGetters: new Set(),
    stateSetters: new Set(),
    refs: new Set(),
    locals: new Set(),
  };

  if (ts.isFunctionDeclaration(componentNode) && componentNode.name) {
    scope.name = componentNode.name.text;
  } else if (ts.isVariableDeclaration(componentNode.parent) && ts.isIdentifier(componentNode.parent.name)) {
    scope.name = componentNode.parent.name.text;
  }

  // Extract props parameter
  let params: readonly ts.ParameterDeclaration[] = [];
  if (ts.isFunctionDeclaration(componentNode) || ts.isFunctionExpression(componentNode) || ts.isArrowFunction(componentNode)) {
    params = componentNode.parameters;
  }

  if (params.length > 0 && params[0]) {
    const firstParam = params[0];
    if (ts.isIdentifier(firstParam.name)) {
      scope.props.add(firstParam.name.text);
    } else if (ts.isObjectBindingPattern(firstParam.name)) {
      for (const element of firstParam.name.elements) {
        if (ts.isIdentifier(element.name)) {
          scope.props.add(element.name.text);
        }
      }
    }
  }

  // Traverse body to find useState, useRef, and top-level declarations in component
  function scanDeclarations(node: Node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const callName = getCallExpressionName(decl.initializer);
          if (callName === "useState") {
            if (ts.isArrayBindingPattern(decl.name)) {
              const elements = decl.name.elements;
              if (elements[0] && ts.isBindingElement(elements[0]) && ts.isIdentifier(elements[0].name)) {
                scope.stateGetters.add(elements[0].name.text);
              }
              if (elements[1] && ts.isBindingElement(elements[1]) && ts.isIdentifier(elements[1].name)) {
                scope.stateSetters.add(elements[1].name.text);
              }
            }
          } else if (callName === "useRef") {
            if (ts.isIdentifier(decl.name)) {
              scope.refs.add(decl.name.text);
            }
          }
        }

        if (ts.isIdentifier(decl.name)) {
          scope.locals.add(decl.name.text);
        }
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      scope.locals.add(node.name.text);
    }
  }

  let bodyNode: Node | undefined;
  if (ts.isFunctionDeclaration(componentNode) || ts.isFunctionExpression(componentNode)) {
    bodyNode = componentNode.body;
  } else if (ts.isArrowFunction(componentNode)) {
    bodyNode = componentNode.body;
  }

  if (bodyNode && ts.isBlock(bodyNode)) {
    for (const stmt of bodyNode.statements) {
      scanDeclarations(stmt);
    }
  }

  return scope;
}

function getCallExpressionName(call: ts.CallExpression): string {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text;
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text;
  }
  return "";
}

function getNodeSnippet(node: Node, sourceFile: SourceFile, maxLen = 80): string {
  try {
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + "...";
  } catch {
    return "";
  }
}

/**
 * Analyzes a single React source file for AI agent anti-patterns.
 */
export function analyzeReactDoctor(sourceText: string, filePath = "unknown.tsx"): ReactDoctorAnalysisResult {
  const violations: ReactDoctorViolation[] = [];
  const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");

  const sourceFile: SourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function addViolation(v: Omit<ReactDoctorViolation, "file">) {
    violations.push({
      ...v,
      file: filePath,
    });
  }

  function getLineCol(node: Node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: pos.line + 1, column: pos.character + 1 };
  }

  // Context stack for component scope & .map loops
  let currentComponent: ComponentScope | null = null;
  let inMapCallback = 0;

  function isComponentNode(node: Node): boolean {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text;
      return !!name && /^[A-Z]/.test(name);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text)) {
      const init = node.initializer;
      return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    }
    return false;
  }

  function checkUseEffectRules(call: ts.CallExpression, scope: ComponentScope) {
    const hookName = getCallExpressionName(call);
    if (!["useEffect", "useLayoutEffect"].includes(hookName)) return;

    const callback = call.arguments[0];
    const depsArg = call.arguments[1];
    const { line, column } = getLineCol(call);

    // Rule 1: Missing dependency array (RD-EFFECT-MISSING-DEPS)
    if (!depsArg) {
      addViolation({
        ruleId: "RD-EFFECT-MISSING-DEPS",
        ruleName: "Missing Dependency Array in Effect Hook",
        severity: ReactDoctorSeverity.Fatal,
        line,
        column,
        snippet: getNodeSnippet(call, sourceFile),
        message: `${hookName} 훅에 의존성 배열(dependency array)이 누락되었습니다. 모든 렌더링마다 실행되어 무한 루프나 불필요한 연산이 발생합니다.`,
        remediation: "두 번째 인자로 빈 배열 `[]` 또는 참조된 상태/속성을 포함하는 의존성 배열을 명시하세요.",
      });
      return;
    }

    // Inspect callback for derived state and missing deps
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      return;
    }

    const declaredDeps = new Set<string>();
    if (ts.isArrayLiteralExpression(depsArg)) {
      for (const elem of depsArg.elements) {
        if (ts.isIdentifier(elem)) {
          declaredDeps.add(elem.text);
        } else if (ts.isPropertyAccessExpression(elem) && ts.isIdentifier(elem.expression)) {
          declaredDeps.add(elem.expression.text);
          declaredDeps.add(elem.getText(sourceFile));
        }
      }
    }

    // Traverse callback to detect derived state setter calls & referenced reactive variables
    const referencedIdentifiers = new Set<string>();
    let hasAsyncBoundary = false;

    function inspectEffectBody(node: Node) {
      if (ts.isCallExpression(node)) {
        const callee = getCallExpressionName(node);

        // Check for async boundary (fetch, setTimeout, addEventListener, etc.)
        if (["fetch", "setTimeout", "setInterval", "addEventListener"].includes(callee) ||
            (ts.isPropertyAccessExpression(node.expression) && ["then", "catch"].includes(node.expression.name.text))) {
          hasAsyncBoundary = true;
        }

        // Rule 2: Unnecessary useEffect for derived state (RD-EFFECT-DERIVED-STATE)
        if (scope.stateSetters.has(callee) || /^set[A-Z]/.test(callee)) {
          if (!hasAsyncBoundary && node.arguments.length > 0) {
            const firstArg = node.arguments[0];
            const argText = firstArg?.getText(sourceFile) ?? "";

            // Check if argument derives from props or existing state
            const derivesFromPropsOrState =
              Array.from(scope.props).some((p) => argText.includes(p)) ||
              Array.from(scope.stateGetters).some((s) => argText.includes(s)) ||
              Array.from(declaredDeps).some((d) => argText.includes(d));

            if (derivesFromPropsOrState) {
              const callPos = getLineCol(node);
              addViolation({
                ruleId: "RD-EFFECT-DERIVED-STATE",
                ruleName: "Unnecessary useEffect for Derived State",
                severity: ReactDoctorSeverity.Fatal,
                line: callPos.line,
                column: callPos.column,
                snippet: getNodeSnippet(node, sourceFile),
                message: `useEffect 내부에서 prop/state 동기화를 위한 ${callee}(...) 호출이 감지되었습니다. 파생 상태는 렌더링 도중 직접 계산하거나 useMemo로 처리해야 합니다.`,
                remediation: "상태 변수를 제거하고 `const derived = calculate(props, state)` 형태로 렌더링 단계에서 직접 계산하세요.",
              });
            }
          }
        }
      }

      if (ts.isIdentifier(node)) {
        const name = node.text;
        if (!GLOBAL_BUILTINS.has(name) &&
            !scope.stateSetters.has(name) &&
            !scope.refs.has(name) &&
            name !== hookName) {
          referencedIdentifiers.add(name);
        }
      }

      ts.forEachChild(node, inspectEffectBody);
    }

    inspectEffectBody(callback);

    // Check missing deps in dependency array
    if (ts.isArrayLiteralExpression(depsArg)) {
      for (const id of referencedIdentifiers) {
        if (scope.props.has(id) || scope.stateGetters.has(id)) {
          if (!declaredDeps.has(id)) {
            addViolation({
              ruleId: "RD-EFFECT-MISSING-DEPS",
              ruleName: "Missing Reactive Dependency in Hook",
              severity: ReactDoctorSeverity.Fatal,
              line,
              column,
              snippet: getNodeSnippet(call, sourceFile),
              message: `${hookName} 내부에서 참조된 반응형 변수 '${id}'가 의존성 배열에 누락되었습니다. stale closure 버그가 발생합니다.`,
              remediation: `의존성 배열에 '${id}'를 추가하거나 불필요한 참조를 제거하세요.`,
            });
          }
        }
      }
    }
  }

  function checkJsxElementRules(
    openingOrSelf: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    parentJsxElement?: ts.JsxElement
  ) {
    const tagName = openingOrSelf.tagName.getText(sourceFile);
    const { line, column } = getLineCol(openingOrSelf);
    const attributes = openingOrSelf.attributes.properties;

    const attrMap = new Map<string, ts.JsxAttribute>();
    for (const attr of attributes) {
      if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name)) {
        attrMap.set(attr.name.text, attr);
      }
    }

    const isCustomComponent = /^[A-Z]/.test(tagName);

    // Rule 3: Inline Object / Array in Custom Component props (RD-INLINE-OBJECT-IN-JSX)
    if (isCustomComponent) {
      for (const [attrName, attr] of attrMap) {
        if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          const expr = attr.initializer.expression;
          if (ts.isObjectLiteralExpression(expr) && expr.properties.length > 0) {
            const attrPos = getLineCol(attr);
            addViolation({
              ruleId: "RD-INLINE-OBJECT-IN-JSX",
              ruleName: "Inline Object Literal in JSX Prop",
              severity: ReactDoctorSeverity.Warn,
              line: attrPos.line,
              column: attrPos.column,
              snippet: getNodeSnippet(attr, sourceFile),
              message: `<${tagName}>의 '${attrName}' 속성에 인라인 객체 리터럴이 전달되었습니다. 매 렌더링마다 새 참조가 생성되어 자식 컴포넌트가 불필요하게 리렌더링됩니다.`,
              remediation: "객체를 컴포넌트 외부 상수로 분리하거나 `useMemo`로 메모이제이션하세요.",
            });
          } else if (ts.isArrayLiteralExpression(expr) && expr.elements.length > 0) {
            const attrPos = getLineCol(attr);
            addViolation({
              ruleId: "RD-INLINE-OBJECT-IN-JSX",
              ruleName: "Inline Array Literal in JSX Prop",
              severity: ReactDoctorSeverity.Warn,
              line: attrPos.line,
              column: attrPos.column,
              snippet: getNodeSnippet(attr, sourceFile),
              message: `<${tagName}>의 '${attrName}' 속성에 인라인 배열 리터럴이 전달되었습니다. 매 렌더링마다 새 참조가 생성됩니다.`,
              remediation: "배열을 컴포넌트 외부 상수로 분리하거나 `useMemo`로 메모이제이션하세요.",
            });
          }
        }
      }
    }

    // Rule 3b: Inline functions inside .map() loops (RD-INLINE-FUNCTION-IN-MAP)
    if (inMapCallback > 0) {
      for (const [attrName, attr] of attrMap) {
        if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          const expr = attr.initializer.expression;
          if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
            const attrPos = getLineCol(attr);
            addViolation({
              ruleId: "RD-INLINE-FUNCTION-IN-MAP",
              ruleName: "Inline Function Creation in Map Loop",
              severity: ReactDoctorSeverity.Warn,
              line: attrPos.line,
              column: attrPos.column,
              snippet: getNodeSnippet(attr, sourceFile),
              message: `.map() 반복 루프 내 <${tagName}>의 '${attrName}'에 인라인 함수가 할당되었습니다. 항목마다 매번 새로운 함수가 생성됩니다.`,
              remediation: "개별 아이템 컴포넌트로 분리하거나 상위 핸들러에 ID를 넘기는 방식을 사용하세요.",
            });
          }
        }
      }
    }

    // Rule 5: ARIA / Accessibility Defects
    // 5a. <img> missing alt attribute (RD-ARIA-IMG-ALT)
    if (tagName === "img") {
      if (!attrMap.has("alt")) {
        addViolation({
          ruleId: "RD-ARIA-IMG-ALT",
          ruleName: "Missing alt attribute on <img>",
          severity: ReactDoctorSeverity.Fatal,
          line,
          column,
          snippet: getNodeSnippet(openingOrSelf, sourceFile),
          message: "<img> 태그에 'alt' 속성이 누락되었습니다. 스크린 리더 사용자가 이미지의 내용을 인식할 수 없습니다.",
          remediation: "대체 텍스트를 제공하는 `alt='설명'` 또는 장식용 이미지의 경우 `alt='' role='presentation'`을 지정하세요.",
        });
      }
    }

    // 5b. <button> missing accessible name (RD-ARIA-BUTTON-NAME)
    if (tagName === "button") {
      const hasAriaLabel = attrMap.has("aria-label") || attrMap.has("aria-labelledby") || attrMap.has("title");
      let hasTextContent = false;

      if (parentJsxElement) {
        for (const child of parentJsxElement.children) {
          if (ts.isJsxText(child) && child.text.trim().length > 0) {
            hasTextContent = true;
            break;
          }
          if (ts.isJsxExpression(child) && child.expression) {
            hasTextContent = true;
            break;
          }
        }
      }

      if (!hasAriaLabel && !hasTextContent) {
        addViolation({
          ruleId: "RD-ARIA-BUTTON-NAME",
          ruleName: "Button Missing Accessible Name",
          severity: ReactDoctorSeverity.Fatal,
          line,
          column,
          snippet: getNodeSnippet(openingOrSelf, sourceFile),
          message: "<button>에 텍스트 또는 aria-label이 지정되지 않았습니다. 보조 기술 사용자가 버튼의 역할을 식별할 수 없습니다.",
          remediation: "버튼 내부에 레이블 텍스트를 추가하거나 `aria-label='기능명'`을 지정하세요.",
        });
      }
    }

    // 5c. Non-interactive element with click handler (RD-ARIA-INTERACTIVE-ROLE)
    const nonInteractiveTags = ["div", "span", "p", "section", "article", "li", "td", "a"];
    if (nonInteractiveTags.includes(tagName)) {
      const hasClickHandler = attrMap.has("onClick") || attrMap.has("onMouseDown");
      const isAnchorWithHref = tagName === "a" && attrMap.has("href");

      if (hasClickHandler && !isAnchorWithHref) {
        const hasRole = attrMap.has("role");
        const hasTabIndex = attrMap.has("tabIndex");
        const hasKeyHandler = attrMap.has("onKeyDown") || attrMap.has("onKeyUp") || attrMap.has("onKeyPress");

        if (!hasRole || !hasTabIndex || !hasKeyHandler) {
          addViolation({
            ruleId: "RD-ARIA-INTERACTIVE-ROLE",
            ruleName: "Non-interactive Element with Click Handler",
            severity: ReactDoctorSeverity.Fatal,
            line,
            column,
            snippet: getNodeSnippet(openingOrSelf, sourceFile),
            message: `비대화형 태그 <${tagName}>에 클릭 핸들러가 있지만 role, tabIndex, 또는 키보드 리스너가 누락되었습니다. 키보드 접근성이 차단됩니다.`,
            remediation: "네이티브 `<button>` 태그를 사용하거나, `role='button' tabIndex={0} onKeyDown={...}`을 구현하세요.",
          });
        }
      }
    }

    // 5d. <input> missing accessible label (RD-ARIA-INPUT-LABEL)
    if (tagName === "input") {
      const typeAttr = attrMap.get("type");
      let inputType = "text";
      if (typeAttr?.initializer && ts.isStringLiteral(typeAttr.initializer)) {
        inputType = typeAttr.initializer.text.toLowerCase();
      }

      if (inputType !== "hidden") {
        const hasLabel = attrMap.has("id") || attrMap.has("aria-label") || attrMap.has("aria-labelledby") || attrMap.has("placeholder");
        if (!hasLabel) {
          addViolation({
            ruleId: "RD-ARIA-INPUT-LABEL",
            ruleName: "Input Element Missing Accessible Label",
            severity: ReactDoctorSeverity.Fatal,
            line,
            column,
            snippet: getNodeSnippet(openingOrSelf, sourceFile),
            message: "<input> 요소에 식별 가능한 라벨(id, aria-label, aria-labelledby)이 누락되었습니다.",
            remediation: "`<label htmlFor='...'>`과 연결되는 id 속성을 부여하거나 `aria-label`을 선언하세요.",
          });
        }
      }
    }
  }

  function checkMapCallRules(call: ts.CallExpression) {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    if (call.expression.name.text !== "map") return;
    if (call.arguments.length === 0) return;

    const callback = call.arguments[0];
    if (!callback) return;

    function checkReturnedJsx(expr: Node) {
      if (ts.isJsxElement(expr)) {
        const opening = expr.openingElement;
        const hasKey = opening.attributes.properties.some(
          (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "key"
        );
        if (!hasKey) {
          const { line, column } = getLineCol(opening);
          addViolation({
            ruleId: "RD-MISSING-KEY",
            ruleName: "Missing 'key' Prop in List Rendering",
            severity: ReactDoctorSeverity.Fatal,
            line,
            column,
            snippet: getNodeSnippet(opening, sourceFile),
            message: `.map() 반환 JSX 요소 <${opening.tagName.getText(sourceFile)}>에 'key' 속성이 누락되었습니다. 렌더링 성능 저하 및 컴포넌트 상태 꼬임이 발생합니다.`,
            remediation: "최상위 반환 요소에 고유하고 안정적인 key 속성(예: key={item.id})을 지정하세요.",
          });
        }
      } else if (ts.isJsxSelfClosingElement(expr)) {
        const hasKey = expr.attributes.properties.some(
          (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "key"
        );
        if (!hasKey) {
          const { line, column } = getLineCol(expr);
          addViolation({
            ruleId: "RD-MISSING-KEY",
            ruleName: "Missing 'key' Prop in List Rendering",
            severity: ReactDoctorSeverity.Fatal,
            line,
            column,
            snippet: getNodeSnippet(expr, sourceFile),
            message: `.map() 반환 요소 <${expr.tagName.getText(sourceFile)} />에 'key' 속성이 누락되었습니다.`,
            remediation: "key 속성(예: key={item.id})을 지정하세요.",
          });
        }
      } else if (ts.isJsxFragment(expr)) {
        const { line, column } = getLineCol(expr);
        addViolation({
          ruleId: "RD-MISSING-KEY",
          ruleName: "Shorthand Fragment in List Rendering Cannot Have Key",
          severity: ReactDoctorSeverity.Fatal,
          line,
          column,
          snippet: getNodeSnippet(expr, sourceFile),
          message: ".map() 반환값으로 단축 프래그먼트(<>...</>)를 사용하면 key를 지정할 수 없습니다.",
          remediation: "<React.Fragment key={item.id}>...</React.Fragment> 문법을 사용하세요.",
        });
      } else if (ts.isParenthesizedExpression(expr)) {
        checkReturnedJsx(expr.expression);
      }
    }

    if (ts.isArrowFunction(callback)) {
      if (ts.isBlock(callback.body)) {
        for (const stmt of callback.body.statements) {
          if (ts.isReturnStatement(stmt) && stmt.expression) {
            checkReturnedJsx(stmt.expression);
          }
        }
      } else {
        checkReturnedJsx(callback.body);
      }
    } else if (ts.isFunctionExpression(callback)) {
      if (callback.body && ts.isBlock(callback.body)) {
        for (const stmt of callback.body.statements) {
          if (ts.isReturnStatement(stmt) && stmt.expression) {
            checkReturnedJsx(stmt.expression);
          }
        }
      }
    }
  }

  function visitor(node: Node) {
    const isNewComponent = isComponentNode(node);
    let previousScope = currentComponent;

    if (isNewComponent) {
      currentComponent = extractComponentScope(node, sourceFile);
    }

    if (currentComponent && ts.isCallExpression(node)) {
      checkUseEffectRules(node, currentComponent);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
      checkMapCallRules(node);
      inMapCallback++;
      ts.forEachChild(node, visitor);
      inMapCallback--;
      return;
    }

    if (ts.isJsxElement(node)) {
      checkJsxElementRules(node.openingElement, node);
    } else if (ts.isJsxSelfClosingElement(node)) {
      checkJsxElementRules(node);
    }

    ts.forEachChild(node, visitor);

    if (isNewComponent) {
      currentComponent = previousScope;
    }
  }

  visitor(sourceFile);

  const fatalCount = violations.filter((v) => v.severity === ReactDoctorSeverity.Fatal).length;
  const warnCount = violations.filter((v) => v.severity === ReactDoctorSeverity.Warn).length;
  const infoCount = violations.filter((v) => v.severity === ReactDoctorSeverity.Info).length;

  // Score calculation: 100 base, -20 per fatal, -5 per warn
  const penalty = fatalCount * 20 + warnCount * 5;
  const score = Math.max(0, 100 - penalty);
  const passed = fatalCount === 0;

  return {
    file: filePath,
    passed,
    score,
    totalViolations: violations.length,
    fatalCount,
    warnCount,
    infoCount,
    violations,
    summary: `${filePath}: ${passed ? "PASS" : "FAIL"} (${score}/100) — Fatal: ${fatalCount}, Warn: ${warnCount}`,
  };
}

/**
 * Scan a list of files or directories for React anti-patterns.
 */
export function inspectReactDoctorFiles(
  paths: string[],
  cwd = process.cwd()
): ReactDoctorGateResult {
  const targetFiles: string[] = [];

  for (const p of paths) {
    const full = resolve(cwd, p);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      function walk(dir: string) {
        for (const entry of readdirSync(dir)) {
          if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".next") continue;
          const sub = join(dir, entry);
          const s = statSync(sub);
          if (s.isDirectory()) walk(sub);
          else if (sub.endsWith(".tsx") || sub.endsWith(".jsx")) targetFiles.push(sub);
        }
      }
      walk(full);
    } else if (p.endsWith(".tsx") || p.endsWith(".jsx")) {
      targetFiles.push(full);
    }
  }

  const results: ReactDoctorAnalysisResult[] = [];
  const allViolations: ReactDoctorViolation[] = [];

  for (const file of targetFiles) {
    try {
      const code = readFileSync(file, "utf8");
      const res = analyzeReactDoctor(code, relative(cwd, file));
      results.push(res);
      allViolations.push(...res.violations);
    } catch (err) {
      console.warn(`[REACT-DOCTOR] 분석 실패 (${file}): ${(err as Error).message}`);
    }
  }

  const fatalCount = allViolations.filter((v) => v.severity === ReactDoctorSeverity.Fatal).length;
  const warnCount = allViolations.filter((v) => v.severity === ReactDoctorSeverity.Warn).length;
  const infoCount = allViolations.filter((v) => v.severity === ReactDoctorSeverity.Info).length;
  const filesWithViolations = results.filter((r) => r.totalViolations > 0).length;

  const totalScore = results.length > 0
    ? Math.round(results.reduce((acc, r) => acc + r.score, 0) / results.length)
    : 100;

  return {
    passed: fatalCount === 0,
    score: totalScore,
    totalFiles: results.length,
    filesWithViolations,
    totalViolations: allViolations.length,
    fatalCount,
    warnCount,
    infoCount,
    results,
    violations: allViolations,
  };
}

/**
 * CLI Runner for react-doctor gate
 */
export function runReactDoctorGateCli(argv = process.argv.slice(2)): number {
  const paths: string[] = [];
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      jsonOutput = true;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  const defaultScan = paths.length > 0 ? paths : ["src", "app", "pages", "components"];
  const res = inspectReactDoctorFiles(defaultScan);

  if (jsonOutput) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("\n================================================================================");
    console.log(`                     REACT DOCTOR QUALITY GATE: ${res.passed ? "✓ PASS" : "❌ FAIL-CLOSED"}`);
    console.log("================================================================================");
    console.log(`- 전체 파일 검사: ${res.totalFiles}건 (위반 발견: ${res.filesWithViolations}건)`);
    console.log(`- 종합 건강 점수: ${res.score}/100`);
    console.log(`- 총 결함: ${res.totalViolations}건 (치명적: ${res.fatalCount}건, 경고: ${res.warnCount}건)`);

    if (res.violations.length > 0) {
      console.log("\n[발견된 안티패턴 목록]");
      for (const v of res.violations) {
        const icon = v.severity === ReactDoctorSeverity.Fatal ? "❌ [FATAL]" : "⚠️ [WARN]";
        console.log(`  ${icon} ${v.file}:${v.line}:${v.column} - ${v.ruleName} (${v.ruleId})`);
        console.log(`     내용: ${v.message}`);
        if (v.snippet) console.log(`     코드: ${v.snippet}`);
        console.log(`     조치: ${v.remediation}`);
      }
    }
    console.log("================================================================================\n");
  }

  return res.passed ? 0 : 1;
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  process.exitCode = runReactDoctorGateCli();
}
