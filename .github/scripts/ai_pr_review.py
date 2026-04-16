"""AI PR Review script.

GitHub Actions から呼ばれ、`pr.diff` を OpenAI Responses API に送信し、
Structured Outputs で JSON レビュー結果を取得して PR にコメントを投稿する。

成果物:
  - ai_review_result.json : OpenAI から返ってきたレビュー JSON
  - ai_review_comment.md  : PR に投稿する Markdown 本文
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import requests
from openai import APIError, OpenAI, OpenAIError

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------

DIFF_PATH = Path("pr.diff")
RESULT_JSON_PATH = Path("ai_review_result.json")
COMMENT_MD_PATH = Path("ai_review_comment.md")

# PR コメントの先頭に付ける識別タグ（既存コメントを上書きするために使う）
COMMENT_MARKER = "<!-- ai-pr-review:auto -->"

# diff が極端に大きい場合の安全側上限（ワークフロー側でも切るが二重防御）
MAX_DIFF_CHARS = 200_000

DEFAULT_MODEL = "gpt-4.1-mini"

SEVERITY_ORDER = {"blocker": 0, "major": 1, "minor": 2}
SEVERITY_LABEL = {
    "blocker": "🛑 Blocker",
    "major": "⚠️ Major",
    "minor": "💡 Minor",
}
RISK_LABEL = {
    "low": "🟢 Low",
    "medium": "🟡 Medium",
    "high": "🔴 High",
}

# diff 本文に対して適用する秘密情報マスクパターン。ファイル名フィルタの抜けを補う。
# パターンは「明らかに秘密情報を示すプレフィックス/構造」のみ。誤検知より見落とし防止優先。
SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # PEM 形式の秘密鍵（RSA/EC/PGP/SSH 等を一括）
    (
        re.compile(
            r"-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----"
        ),
        "[REDACTED:PRIVATE_KEY]",
    ),
    # Google API キー
    (re.compile(r"\bAIza[0-9A-Za-z\-_]{20,}\b"), "[REDACTED:GOOGLE_API_KEY]"),
    # OpenAI / Anthropic / GitHub PAT 等のプレフィックス系
    (
        re.compile(
            r"\b(?:sk-(?:proj-|ant-|live-|test-)?|sk_live_|sk_test_|"
            r"ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|"
            r"xox[abprs]-|"
            r"AKIA|ASIA)[0-9A-Za-z\-_]{16,}\b"
        ),
        "[REDACTED:TOKEN]",
    ),
    # JWT
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
        "[REDACTED:JWT]",
    ),
    # AWS Secret Access Key（"aws_secret_access_key = ..." の形）
    (
        re.compile(
            r"(?i)\b(aws[_\-]?secret[_\-]?access[_\-]?key)\s*[:=]\s*['\"]?([A-Za-z0-9/+=]{40})['\"]?"
        ),
        r"\1=[REDACTED:AWS_SECRET]",
    ),
]

# Structured Outputs 用 JSON Schema
REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "overall_risk", "findings"],
    "properties": {
        "summary": {
            "type": "string",
            "description": "この PR 全体の総評（日本語、3〜6文程度）",
        },
        "overall_risk": {
            "type": "string",
            "enum": ["low", "medium", "high"],
        },
        "findings": {
            "type": "array",
            "description": "重要な指摘のみ。軽微な指摘は含めない。なければ空配列",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "severity",
                    "file",
                    "line",
                    "title",
                    "reason",
                    "suggestion",
                ],
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["blocker", "major", "minor"],
                    },
                    "file": {
                        "type": "string",
                        "description": "リポジトリ相対パス。不明なら空文字",
                    },
                    "line": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "HEAD 側の行番号（推定可）。不明なら 0",
                    },
                    "title": {
                        "type": "string",
                        "description": "指摘の見出し（短く）",
                    },
                    "reason": {
                        "type": "string",
                        "description": "なぜ問題か。バグ・セキュリティ等の観点を日本語で",
                    },
                    "suggestion": {
                        "type": "string",
                        "description": "具体的な修正案。必要ならコード断片を含める",
                    },
                },
            },
        },
    },
}

SYSTEM_PROMPT = """あなたはシニアソフトウェアエンジニアです。
GitHub Pull Request の差分（unified diff 形式）をレビューします。

# 指摘優先順位（上が最優先）
1. Correctness / bug risk（ロジック誤り・境界条件・nullや型の崩れ）
2. Security（秘密情報の混入、認可漏れ、インジェクション等）
3. Data loss / destructive behavior（破壊的変更、マイグレーション事故）
4. Reliability / error handling（例外の握り潰し、リトライ欠落）
5. Performance issues likely to matter（明らかな N+1、重大なメモリ増加）
6. Maintainability and test gaps（複雑度、テスト不在）

# ルール
- スタイルや好みの問題（命名の揺れ等）は出さない。実害重視。
- diff から合理的に読み取れる範囲で指摘する。推測や過剰な一般論は避ける。
- 問題がなければ findings を空配列にして、その旨を summary で明示する。
- 高シグナル・少数精鋭で返す。些末な指摘でコメントを膨らませない。
- 各指摘には severity / file / line / title / reason / suggestion を必ず入れる。
- 文章は日本語。line は diff の HEAD 側（"+" 行）の行番号を可能な範囲で推定し、
  不明なら 0 を入れる。
- 出力は必ず指定された JSON スキーマに厳密準拠する。"""

USER_PROMPT_TEMPLATE = """# PR メタ情報
- リポジトリ: {repo}
- PR 番号: #{pr_number}
- タイトル: {title}
- 本文:
{body}

- base SHA: {base_sha}
- head SHA: {head_sha}

# 差分（unified diff）
```diff
{diff}
```
"""


# ---------------------------------------------------------------------------
# 環境変数・入力
# ---------------------------------------------------------------------------


def read_env(name: str, *, required: bool = True, default: str = "") -> str:
    """環境変数を取り出す。必須なのに空なら非ゼロ終了。"""
    val = os.environ.get(name, default)
    if required and not val:
        print(f"::error::missing required env: {name}", file=sys.stderr)
        sys.exit(1)
    return val


def load_diff() -> str:
    """pr.diff を読む。巨大なら切り詰める。秘密情報パターンはマスクする。"""
    if not DIFF_PATH.exists():
        print(f"::warning::{DIFF_PATH} not found", file=sys.stderr)
        return ""
    text = DIFF_PATH.read_text(encoding="utf-8", errors="replace")
    if len(text) > MAX_DIFF_CHARS:
        text = text[:MAX_DIFF_CHARS] + "\n\n... [diff truncated by script] ...\n"
    return redact_secrets(text)


def redact_secrets(text: str) -> str:
    """diff 本文から秘密情報パターンをマスクする。ファイル名除外の補強。

    OpenAI への送信前に必ず通す。検知件数はログに残し、内容そのものは出さない。
    """
    if not text:
        return text
    redacted = text
    total = 0
    for pattern, replacement in SECRET_PATTERNS:
        redacted, n = pattern.subn(replacement, redacted)
        total += n
    if total:
        print(f"redacted {total} suspected secret(s) from diff before sending to OpenAI")
    return redacted


# ---------------------------------------------------------------------------
# OpenAI Responses API
# ---------------------------------------------------------------------------


def build_user_prompt(
    *,
    repo: str,
    pr_number: str,
    title: str,
    body: str,
    base_sha: str,
    head_sha: str,
    diff: str,
) -> str:
    return USER_PROMPT_TEMPLATE.format(
        repo=repo,
        pr_number=pr_number,
        title=title or "(no title)",
        body=(body or "(no description)").strip(),
        base_sha=base_sha,
        head_sha=head_sha,
        diff=diff or "(empty diff)",
    )


def _responses_create(client: OpenAI, *, model: str, messages: list[dict[str, str]]) -> Any:
    """Responses API 呼び出し。store=False（サーバ側保存なし）で送る。

    古い SDK で `store` や `text.format.json_schema` 形式を受け付けない場合に備え、
    段階的にフォールバックする。
    """
    common_kwargs: dict[str, Any] = {
        "model": model,
        "input": messages,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "pr_review",
                "schema": REVIEW_SCHEMA,
                "strict": True,
            }
        },
    }
    try:
        return client.responses.create(store=False, **common_kwargs)
    except TypeError:
        # 古い SDK で store 引数が無い場合
        return client.responses.create(**common_kwargs)


def call_openai_review(
    client: OpenAI,
    model: str,
    *,
    repo: str,
    pr_number: str,
    title: str,
    body: str,
    base_sha: str,
    head_sha: str,
    diff: str,
) -> dict[str, Any]:
    """Responses API + Structured Outputs でレビュー結果を取得する。"""
    user_prompt = build_user_prompt(
        repo=repo,
        pr_number=pr_number,
        title=title,
        body=body,
        base_sha=base_sha,
        head_sha=head_sha,
        diff=diff,
    )

    try:
        response = _responses_create(
            client,
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
    except APIError as exc:
        raise RuntimeError(f"OpenAI API error: {exc}") from exc
    except OpenAIError as exc:
        raise RuntimeError(f"OpenAI client error: {exc}") from exc

    raw = extract_response_text(response)
    if not raw:
        raise RuntimeError(
            f"OpenAI response body was empty (response type={type(response).__name__})"
        )

    return parse_review_json(raw)


def extract_response_text(response: Any) -> str:
    """Responses API のレスポンスからテキスト本文を取り出す。

    SDK 差異吸収のため、`output_text` を第一候補にしつつ、
    `response.output[*].content[*].text` を辿るフォールバックを持つ。
    どの経路で取り出したかを短くログ出しする（取得失敗時の調査用）。
    """
    # 1) 公式 SDK の集約プロパティ
    primary = (getattr(response, "output_text", "") or "").strip()
    if primary:
        return primary

    # 2) output 配列を辿る（SDK バージョンや response 種別差を吸収）
    chunks: list[str] = []
    output = getattr(response, "output", None) or []
    for item in output:
        # item.content は list[ResponseOutputText | ...] を想定
        content = getattr(item, "content", None) or []
        for piece in content:
            text_val = getattr(piece, "text", None)
            if isinstance(text_val, str) and text_val:
                chunks.append(text_val)
            elif isinstance(piece, dict) and isinstance(piece.get("text"), str):
                chunks.append(piece["text"])

    if chunks:
        joined = "".join(chunks).strip()
        if joined:
            print("extract_response_text: used fallback path response.output[*].content[*].text")
            return joined

    # 3) dict 化できる場合の最終フォールバック（古い SDK / 想定外形式）
    try:
        as_dict = response.model_dump() if hasattr(response, "model_dump") else None
    except Exception:  # noqa: BLE001
        as_dict = None
    if isinstance(as_dict, dict):
        text_val = as_dict.get("output_text") or ""
        if isinstance(text_val, str) and text_val.strip():
            print("extract_response_text: used fallback path model_dump.output_text")
            return text_val.strip()

    return ""


def parse_review_json(raw: str) -> dict[str, Any]:
    """モデル出力を JSON としてパース。念のためのコードフェンス除去も行う。"""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        cleaned = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as exc:
            preview = cleaned[:300]
            raise RuntimeError(
                f"failed to parse OpenAI JSON output: {exc}; preview={preview!r}"
            ) from exc


# ---------------------------------------------------------------------------
# バリデーション
# ---------------------------------------------------------------------------


def validate_result(result: Any) -> dict[str, Any]:
    """モデル出力をスキーマに沿って軽く正規化する。

    OpenAI 側の strict mode で弾かれるのが基本だが、
    ネットワーク事情でのフォールバックや将来のモデル差分に備えて二重に検査する。
    """
    if not isinstance(result, dict):
        raise RuntimeError("review result must be a JSON object")

    summary = str(result.get("summary") or "").strip()
    risk = result.get("overall_risk") or "low"
    if risk not in RISK_LABEL:
        risk = "low"

    findings_raw = result.get("findings") or []
    if not isinstance(findings_raw, list):
        findings_raw = []

    findings: list[dict[str, Any]] = []
    for item in findings_raw:
        if not isinstance(item, dict):
            continue
        severity = item.get("severity")
        if severity not in SEVERITY_ORDER:
            severity = "minor"
        try:
            line = int(item.get("line") or 0)
        except (TypeError, ValueError):
            line = 0
        findings.append(
            {
                "severity": severity,
                "file": str(item.get("file") or "").strip(),
                "line": max(line, 0),
                "title": str(item.get("title") or "").strip() or "(no title)",
                "reason": str(item.get("reason") or "").strip(),
                "suggestion": str(item.get("suggestion") or "").strip(),
            }
        )

    findings.sort(key=lambda f: SEVERITY_ORDER.get(f["severity"], 99))

    return {
        "summary": summary,
        "overall_risk": risk,
        "findings": findings,
    }


# ---------------------------------------------------------------------------
# Markdown 整形
# ---------------------------------------------------------------------------


def render_markdown(
    result: dict[str, Any],
    *,
    model: str,
    pr_number: str,
    head_sha: str,
) -> str:
    summary = result["summary"] or "(総評なし)"
    risk = result["overall_risk"]
    findings: list[dict[str, Any]] = result["findings"]

    lines: list[str] = [
        COMMENT_MARKER,
        "## AIレビュー結果",
        "",
        f"**対象**: PR #{pr_number} (`{head_sha[:7]}`) / モデル: `{model}`",
        "",
        "### 総評",
        "",
        summary,
        "",
        "### リスク",
        "",
        f"- 総合リスク: {RISK_LABEL.get(risk, risk)}",
        f"- 指摘件数: {len(findings)} 件",
        "",
        "### 指摘一覧",
        "",
    ]

    if not findings:
        lines.append("- 重大な指摘は見当たりませんでした。")
        lines.append(
            "- 必要なら人間レビューで仕様整合性とテスト観点を追加確認してください。"
        )
    else:
        for i, f in enumerate(findings, start=1):
            sev = SEVERITY_LABEL.get(f["severity"], f["severity"])
            file_ = f["file"] or "(unknown)"
            loc = f"`{file_}`" + (f":L{f['line']}" if f["line"] else "")
            lines.append(f"#### {i}. {sev} — {f['title']}")
            lines.append("")
            lines.append(f"- 場所: {loc}")
            lines.append("")
            if f["reason"]:
                lines.append("**理由**")
                lines.append("")
                lines.append(f["reason"])
                lines.append("")
            if f["suggestion"]:
                lines.append("**修正案**")
                lines.append("")
                lines.append(f["suggestion"])
                lines.append("")

    lines.append("---")
    lines.append(
        "_GitHub Actions による自動レビューです。誤検知の可能性があるため、"
        "最終判断はレビュアーが行ってください。_"
    )
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-pr-review-bot",
    }


def _github_request(
    token: str,
    method: str,
    url: str,
    *,
    json_body: dict[str, Any] | None = None,
) -> requests.Response:
    resp = requests.request(
        method,
        url,
        headers=_github_headers(token),
        json=json_body,
        timeout=30,
    )
    if resp.status_code >= 400:
        # レスポンス本文は最初の 500 文字だけにとどめる（ログ肥大防止）
        print(
            f"::error::GitHub API {method} {url} failed: "
            f"{resp.status_code} {resp.text[:500]}",
            file=sys.stderr,
        )
    resp.raise_for_status()
    return resp


def find_existing_comment(token: str, repo: str, pr_number: str) -> int | None:
    """COMMENT_MARKER を含む既存コメントの id を返す。無ければ None。"""
    url: str | None = (
        f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments?per_page=100"
    )
    while url:
        resp = _github_request(token, "GET", url)
        for c in resp.json():
            if COMMENT_MARKER in (c.get("body") or ""):
                return int(c["id"])
        link = resp.headers.get("Link", "")
        match = re.search(r'<([^>]+)>;\s*rel="next"', link)
        url = match.group(1) if match else None
    return None


def upsert_pr_comment(token: str, repo: str, pr_number: str, body: str) -> None:
    existing_id = find_existing_comment(token, repo, pr_number)
    if existing_id:
        print(f"updating existing comment id={existing_id}")
        _github_request(
            token,
            "PATCH",
            f"https://api.github.com/repos/{repo}/issues/comments/{existing_id}",
            json_body={"body": body},
        )
    else:
        print("creating new comment")
        _github_request(
            token,
            "POST",
            f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments",
            json_body={"body": body},
        )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def run_review() -> dict[str, Any]:
    """OpenAI を呼んでレビュー結果を得る。

    OPENAI_API_KEY 欠落 / 空 diff / API 失敗は、すべて空 findings の結果として
    返し、後段の upsert コメントに吸収させる（Skip も Error も Success も
    全て同じ単一コメントへ集約することで、重複コメントを構造的に防ぐ）。
    """
    openai_api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    model = read_env("OPENAI_MODEL", required=False, default=DEFAULT_MODEL)
    repo = read_env("GITHUB_REPOSITORY")
    pr_number = read_env("PR_NUMBER")
    pr_title = read_env("PR_TITLE", required=False)
    pr_body = read_env("PR_BODY", required=False)
    base_sha = read_env("BASE_SHA")
    head_sha = read_env("HEAD_SHA")

    if not openai_api_key:
        # フォーク PR や secret 未登録ケース。job は success で終わらせ、
        # PR には skip 理由のみを upsert する（次回実行時に同じコメントが上書きされる）。
        print(
            "::warning::OPENAI_API_KEY is not available "
            "(fork PR or missing secret). AI review will be skipped."
        )
        return {
            "summary": (
                "`OPENAI_API_KEY` がこの実行に渡らなかったため、AI レビューを実行しませんでした。"
                "フォーク元 PR の場合、リポジトリ設定で fork からの secrets 提供を許可する必要があります"
                "（漏えいリスクがあるため通常は推奨しません）。"
            ),
            "overall_risk": "low",
            "findings": [],
        }

    diff = load_diff()
    if not diff or diff.strip() == "(no reviewable diff)":
        return {
            "summary": "レビュー対象となる差分が検出されませんでした。",
            "overall_risk": "low",
            "findings": [],
        }

    client = OpenAI(api_key=openai_api_key)
    try:
        raw_result = call_openai_review(
            client,
            model,
            repo=repo,
            pr_number=pr_number,
            title=pr_title,
            body=pr_body,
            base_sha=base_sha,
            head_sha=head_sha,
            diff=diff,
        )
        return validate_result(raw_result)
    except Exception as exc:  # noqa: BLE001 (API 失敗は必ず飲み込んでコメント化)
        print(f"::error::AI review failed: {exc}", file=sys.stderr)
        return {
            "summary": f"AI レビューの実行中にエラーが発生しました: {exc}",
            "overall_risk": "low",
            "findings": [],
        }


def main() -> int:
    result = run_review()

    # artifact 用に JSON を保存
    RESULT_JSON_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    model = read_env("OPENAI_MODEL", required=False, default=DEFAULT_MODEL)
    pr_number = read_env("PR_NUMBER")
    head_sha = read_env("HEAD_SHA")
    github_token = read_env("GITHUB_TOKEN")
    repo = read_env("GITHUB_REPOSITORY")

    markdown = render_markdown(
        result,
        model=model,
        pr_number=pr_number,
        head_sha=head_sha,
    )
    COMMENT_MD_PATH.write_text(markdown, encoding="utf-8")

    # PR コメント投稿の失敗は常に「警告で完走」とする。
    # レビュー結果そのものは artifact (ai_review_result.json / ai_review_comment.md)
    # に保存済みのため、投稿失敗で job 全体を失敗扱いにする実害は薄い。
    # GitHub 側障害・rate limit・fork PR の権限制約などをすべて吸収する方針。
    try:
        upsert_pr_comment(github_token, repo, pr_number, markdown)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        hint = ""
        if status in (401, 403):
            hint = " (fork PR だと GITHUB_TOKEN が読み取り専用に絞られることが原因の可能性あり)"
        print(
            f"::warning::PR comment upsert failed (HTTP {status}){hint}. "
            "Review result is still available in artifacts.",
            file=sys.stderr,
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        # secrets をログに流さないよう例外型名のみ
        print(
            f"::warning::PR comment upsert failed ({type(exc).__name__}). "
            "Review result is still available in artifacts.",
            file=sys.stderr,
        )
        return 0

    print("AI PR review completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
