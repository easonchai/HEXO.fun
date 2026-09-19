// The admin CLI's entry point, and nothing else. Split from index.ts so that
// importing the commands (as admin.test.ts does) never reads an env, parses
// argv or opens a connection.
import { main, reportFailure } from "./index";

main().catch(reportFailure);
