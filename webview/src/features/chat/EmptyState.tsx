import { motion } from "framer-motion";
import { send } from "../../lib/rpc";
import { Icon, IconName } from "../../design/icons";
import { Kbd, Orb } from "../../design/primitives";
import { ENTER, SPRING_POP, enterAt } from "../../design/motion";
import s from "./EmptyState.module.scss";

interface SuggestionItem {
  icon: IconName;
  title: string;
  sub: string;
  prompt: string;
}

interface SuggestionGroup {
  label: string;
  items: SuggestionItem[];
}

const GROUPS: ReadonlyArray<SuggestionGroup> = [
  {
    label: "Understand",
    items: [
      {
        icon: "book",
        title: "Explain this codebase",
        sub: "Walk through architecture and key symbols",
        prompt: "Explain this codebase"
      },
      {
        icon: "search",
        title: "Find and fix a bug",
        sub: "Search for the issue, then patch it",
        prompt: "Find and fix a bug"
      }
    ]
  },
  {
    label: "Build",
    items: [
      {
        icon: "edit",
        title: "Refactor for clarity",
        sub: "Extract helpers, preserve behavior",
        prompt: "Refactor for clarity"
      },
      {
        icon: "bolt",
        title: "Write tests for the selected file",
        sub: "Match existing test patterns",
        prompt: "Write tests for the selected file"
      }
    ]
  }
];

export function EmptyState() {
  // One flat reveal ladder, walked top to bottom, so the stagger reads as a
  // single sweep down the screen instead of restarting inside every group.
  // Rung 0 is the orb, 1 the headline, 2 the subhead; groups take it from there.
  let rung = 2;
  return (
    <motion.div className={s.root} {...ENTER}>
      {/* The brand mark is the one element here that gets a spring —
          SPRING_POP exists for exactly this. Only the container's arrival is
          animated; the Orb's own rotation is untouched. */}
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={SPRING_POP}
      >
        <Orb size={84} />
      </motion.div>
      <motion.div className={s.title} {...enterAt(1)}>
        What are we building?
      </motion.div>
      <motion.div
        className={s.sub}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        // Opacity only — this line sits tight under the headline and must not
        // move, so it takes ENTER's timing without ENTER's rise.
        transition={enterAt(2).transition}
      >
        Mention files with <Kbd>@</Kbd> · pick a mode for the kind of help you need
      </motion.div>
      {GROUPS.map((g) => {
        const headRung = ++rung;
        return (
          <motion.section
            key={g.label}
            className={s.section}
            {...enterAt(headRung)}
          >
            <div className={s.sectionHead}>
              <span className={s.sectionBadge}>{g.label}</span>
              <div className={s.sectionLine} />
            </div>
            <div className={s.items}>
              {g.items.map((item) => {
                const itemRung = ++rung;
                return (
                  <Suggestion key={item.title} item={item} rung={itemRung} />
                );
              })}
            </div>
          </motion.section>
        );
      })}
    </motion.div>
  );
}

function Suggestion({ item, rung }: { item: SuggestionItem; rung: number }) {
  return (
    <motion.button
      type="button"
      {...enterAt(rung)}
      className={s.suggestion}
      onClick={() => send({ type: "prompt", text: item.prompt })}
    >
      <span className={s.suggestionIcon}>
        <Icon name={item.icon} size={15} />
      </span>
      <span className={s.suggestionBody}>
        <span className={s.suggestionTitle}>{item.title}</span>
        <span className={s.suggestionSub}>{item.sub}</span>
      </span>
      <Icon name="arrow" size={14} className={s.suggestionArrow} />
    </motion.button>
  );
}
