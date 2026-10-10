import { DEFAULT_RUN_MODE, LIMITS, MAX_REPLY_LIKES, type RunModeSpec } from '@disco-lurk/core';
import type { StoredPreset } from '@disco-lurk/server/contract';
import { useState } from 'preact/hooks';
import { copy } from '../copy';
import { ReplyRiskDialog } from './dialog';
import { Field, NumberInput, RangeInput, Segmented, Toggle } from './fields';

type Interaction = StoredPreset['interaction'];

export function RunModeField(props: { value: RunModeSpec; browseMode: StoredPreset['browseMode']; onChange(m: RunModeSpec): void }) {
  const m = props.value;
  return (
    <Field label={copy.run.runMode} hint={m.kind === 'topics' ? copy.run.topicsHint[props.browseMode] : undefined}>
      <Segmented
        label={copy.run.runMode}
        value={m.kind}
        options={(['endless', 'topics', 'time'] as const).map((k) => ({ value: k, label: copy.run.runModes[k] }))}
        onChange={(k) => props.onChange(k === 'endless' ? { kind: 'endless' } : k === 'topics' ? structuredClone(DEFAULT_RUN_MODE) : { kind: 'time', minutes: 30 })}
      />
      {m.kind === 'topics' && <RangeInput label={copy.run.topicsRange} value={m} lo={1} hi={LIMITS.topicsTarget} onChange={(r) => props.onChange({ kind: 'topics', ...r })} />}
      {m.kind === 'time' && (
        <NumberInput label={copy.run.timeMinutes} value={m.minutes} min={1} max={LIMITS.timeModeMax} suffix={copy.common.minutes} onChange={(minutes) => props.onChange({ kind: 'time', minutes })} />
      )}
    </Field>
  );
}

/** Likes and replies; turning replies on waits for the risk dialog, and cancelling leaves them off. */
export function InteractionField(props: { value: Interaction; onChange(i: Interaction): void }) {
  const i = props.value;
  const [askReply, setAskReply] = useState(false);
  const setLike = (patch: Partial<Interaction['like']>) => props.onChange({ ...i, like: { ...i.like, ...patch } });
  const setReply = (patch: Partial<Interaction['reply']>) => props.onChange({ ...i, reply: { ...i.reply, ...patch } });
  return (
    <>
      {askReply && (
        <ReplyRiskDialog
          onConfirm={() => {
            setAskReply(false);
            setReply({ enabled: true, riskAcknowledged: true });
          }}
          onCancel={() => setAskReply(false)}
        />
      )}
      <Toggle label={copy.run.like} checked={i.like.enabled} onChange={(enabled) => setLike({ enabled })} />
      {i.like.enabled && (
        <div class="sub">
          <label>
            {copy.run.likeRate} <NumberInput label={copy.run.likeRate} value={i.like.topicRate} min={0} max={100} suffix="%" onChange={(topicRate) => setLike({ topicRate })} />
          </label>
          <label>
            {copy.run.replyLikeRate} <NumberInput label={copy.run.replyLikeRate} value={i.like.replyRate} min={0} max={100} suffix="%" onChange={(replyRate) => setLike({ replyRate })} />
          </label>
          <label>
            {copy.run.replyLikeMax} <NumberInput label={copy.run.replyLikeMax} value={i.like.maxReplies} min={0} max={MAX_REPLY_LIKES} onChange={(maxReplies) => setLike({ maxReplies })} />
          </label>
        </div>
      )}
      <Toggle label={copy.run.reply} checked={i.reply.enabled} onChange={(on) => (on ? setAskReply(true) : setReply({ enabled: false, riskAcknowledged: false }))} />
      {i.reply.enabled && (
        <div class="sub">
          <label>
            {copy.run.replyRate} <NumberInput label={copy.run.replyRate} value={i.reply.rate} min={0} max={100} suffix="%" onChange={(rate) => setReply({ rate })} />
          </label>
        </div>
      )}
    </>
  );
}

export function ExtraWaitField(props: { value: StoredPreset['extraWait']; onChange(w: StoredPreset['extraWait']): void }) {
  const w = props.value;
  return (
    <>
      <Toggle label={copy.run.extraWait} checked={w.enabled} onChange={(enabled) => props.onChange({ ...w, enabled })} />
      {w.enabled && (
        <div class="sub">
          <RangeInput
            label={copy.run.extraWaitRange}
            value={{ min: w.minSec, max: w.maxSec }}
            lo={0}
            hi={LIMITS.extraWaitSec}
            suffix={copy.common.seconds}
            onChange={(r) => props.onChange({ ...w, minSec: r.min, maxSec: r.max })}
          />
        </div>
      )}
    </>
  );
}

export function SampleField(props: { value: StoredPreset['samplePerCategory']; onChange(s: StoredPreset['samplePerCategory']): void }) {
  return (
    <Field label={copy.run.sample}>
      <RangeInput label={copy.run.sample} value={props.value} lo={1} hi={LIMITS.samplePerCategory} onChange={props.onChange} />
    </Field>
  );
}

export function QuickFloorsField(props: { value: { min: number; max: number }; onChange(f: { min: number; max: number }): void }) {
  return (
    <label>
      {copy.run.quickFloors} <RangeInput label={copy.run.quickFloors} value={props.value} lo={1} hi={LIMITS.quickFloors} onChange={props.onChange} />
    </label>
  );
}
