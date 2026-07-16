// unjargond is the unjargon.app collector: a dumb tail-and-ship daemon that
// watches agent transcript files (Claude Code JSONL) and posts new assistant
// messages to the unjargon web app. All LLM work happens server-side.
package main

import (
	"fmt"
	"os"
)

const usage = `unjargond — the unjargon.app collector

Usage:
  unjargond run                       tail live agent transcripts and ship them
  unjargond replay <fixture.jsonl>    replay a recorded session through the pipeline

Flags are documented per subcommand: unjargond <cmd> -h
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "run", "replay":
		fmt.Fprintf(os.Stderr, "unjargond: %q is not implemented yet\n", os.Args[1])
		os.Exit(1)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}
