import { canvasGet, getCanvasConfig } from "../lib/canvas-client.mjs";

let config;
try {
  config = getCanvasConfig();
} catch {
  console.error("CANVAS_BASE_URL と CANVAS_API_TOKEN を設定してください。");
  console.error("方法1: .env.example を .env にコピーして値を入れる");
  console.error("方法2: $env:CANVAS_BASE_URL='https://canvas.example.ac.jp'");
  console.error("方法2: $env:CANVAS_API_TOKEN='xxxxxxxx'");
  process.exit(1);
}

function printCourse(course) {
  const name = course.name ?? course.course_code ?? "(名称なし)";
  const id = course.id ?? "(IDなし)";
  console.log(`- ${name} / course_id=${id}`);
}

console.log("Canvas API の疎通確認を開始します。");
console.log(`接続先: ${config.baseUrl}`);

const profile = await canvasGet("/api/v1/users/self/profile");
console.log("\nユーザー情報を取得できました。");
console.log(`名前: ${profile.name ?? "(取得なし)"}`);
console.log(`ログインID: ${profile.login_id ?? "(取得なし)"}`);

const courses = await canvasGet("/api/v1/courses?enrollment_state=active&per_page=10");
console.log(`\nアクティブなコースを ${courses.length} 件取得しました。`);
courses.forEach(printCourse);

if (courses.length > 0 && courses[0].id) {
  const assignments = await canvasGet(`/api/v1/courses/${courses[0].id}/assignments?bucket=upcoming&per_page=10`);
  console.log(`\n先頭コースの今後の課題を ${assignments.length} 件取得しました。`);
  for (const assignment of assignments) {
    const dueAt = assignment.due_at ?? "期限なし";
    console.log(`- ${assignment.name ?? "(名称なし)"} / due_at=${dueAt}`);
  }
}

console.log("\nCanvas API からデータを取得できました。");
