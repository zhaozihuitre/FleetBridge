// Standing constraints (improvement P-008): what used to be written into order after order.
//
// 1. SECRET_HINT, in the system prompt of every agent Fleet Bridge starts (the master too): secrets are not
//    written out in answers and reports. Reading and using them is not limited, and an order that asks for
//    the value itself lifts the rule: a task that needs to read configuration goes on as before.
// 2. A read-only order: the master sets readonly on fleet_send / fleet_spawn and the limits (no changes, no
//    commit or push, no deploy) are added to the order here, once and always in the same words.
import { L } from './i18n.js';

/** Added to our agents' system prompt (server/agents.js). */
export const SECRET_HINT =
  'Secrets stay out of what you write: never put the value of an API key, token, password, private key, session cookie or the credentials of a connection string verbatim in your answers, reports or commit messages. Reading and using them for the task is fine. To refer to one, say where it lives and what it is called (file, variable, header name) and show at most its first 4 characters followed by "…". The only exception is an order that explicitly asks you to show that value itself.';

/** How a read-only order is marked: looked for so the limits are never added twice. */
export const READONLY_MARK = '【只读调查】';

export function readOnlyNote() {
  return `${READONLY_MARK}${L(
    '这是一次只读调查：只看、只查、只汇报。不修改代码和配置（不新建、不编辑、不删除项目里的文件），不提交、不 push，不部署、不发布，不改数据库和线上环境的数据。发现该改的地方写进汇报当作建议，不要动手。',
    'This is a read-only investigation: look, check and report only. Do not change code or configuration (no creating, editing or deleting of project files), do not commit or push, do not deploy or release, do not change data in databases or live environments. What should be changed goes into your report as a suggestion; do not do it.',
    'これは読み取り専用の調査です：見る・調べる・報告するだけ。コードや設定を変更しない（プロジェクトのファイルを作成・編集・削除しない）、コミットや push をしない、デプロイやリリースをしない、データベースや本番環境のデータを変更しない。直すべき点は提案として報告に書き、手を動かさないこと。',
  )}`;
}

/** The order with the read-only limits after it (the order's own words stay first, as the log shows them). */
export function readOnlyOrder(text) {
  const t = String(text ?? '').trim();
  if (!t || t.includes(READONLY_MARK)) return t;
  return `${t}\n\n${readOnlyNote()}`;
}
