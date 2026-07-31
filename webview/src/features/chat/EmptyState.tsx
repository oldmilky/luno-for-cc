import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { onMessage, send, type SlashCommand } from "../../lib/rpc";
import { useWebviewSettings } from "../../lib/settings";
import { Icon } from "../../design/icons";
import { Kbd, Orb } from "../../design/primitives";
import { ENTER, SPRING_POP, enterAt } from "../../design/motion";
import { resolveStartupCards, type StartupCard } from "./startup-suggestions";
import s from "./EmptyState.module.scss";

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const commands = useSlashCommands();
  const { startupSuggestions } = useWebviewSettings();
  const groups = resolveStartupCards(startupSuggestions, commands);

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
        Mention files with <Kbd>@</Kbd> · pick a mode for the kind of help you
        need
      </motion.div>
      {groups.map((g) => {
        const headRung = ++rung;
        return (
          <motion.section
            key={g.label ?? "default"}
            className={s.section}
            {...enterAt(headRung)}
          >
            {g.label && (
              <div className={s.sectionHead}>
                <span className={s.sectionBadge}>{g.label}</span>
                <div className={s.sectionLine} />
              </div>
            )}
            <div className={s.items}>
              {g.items.map((item) => {
                const itemRung = ++rung;
                return (
                  <Suggestion
                    key={item.title}
                    item={item}
                    rung={itemRung}
                    onPick={onPick}
                  />
                );
              })}
            </div>
          </motion.section>
        );
      })}
    </motion.div>
  );
}

/** The same list the composer's slash popover reads. Requested on mount rather
 *  than held in a store: the hero unmounts the moment a turn starts. */
function useSlashCommands(): SlashCommand[] {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    send({ type: "requestSlashCommands" });
    return onMessage((m) => {
      if (m.type === "slashCommands") setCommands(m.commands);
    });
  }, []);
  return commands;
}

function Suggestion({
  item,
  rung,
  onPick
}: {
  item: StartupCard;
  rung: number;
  onPick: (text: string) => void;
}) {
  return (
    <motion.button
      type="button"
      {...enterAt(rung)}
      className={s.suggestion}
      onClick={() => onPick(item.text)}
    >
      <span className={s.suggestionIcon}>
        <Icon name="bolt" size={15} />
      </span>
      <span className={s.suggestionBody}>
        <span className={s.suggestionTitle}>{item.title}</span>
        {item.sub && <span className={s.suggestionSub}>{item.sub}</span>}
      </span>
      <Icon name="arrow" size={14} className={s.suggestionArrow} />
    </motion.button>
  );
}
