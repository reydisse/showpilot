/** Parse transport input once at the socket, HTTP, or native UI boundary. */
export function parseRundownTransport(action, payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  switch (action) {
    case 'timer-start':
      if (value.itemId !== undefined && (typeof value.itemId !== 'string' || !value.itemId)) return null;
      return { type: action, ...(value.itemId === undefined ? {} : { itemId: value.itemId }) };
    case 'timer-resume': case 'timer-pause': case 'timer-stop': case 'timer-next': case 'timer-prev':
      return { type: action };
    case 'timer-adjust':
      return typeof value.deltaMs === 'number' && Number.isFinite(value.deltaMs) && Math.abs(value.deltaMs) <= 86_400_000
        ? { type: action, deltaMs: value.deltaMs } : null;
    case 'timer-mode':
      return ['count-up','count-down','clock'].includes(value.mode) ? { type: action, mode: value.mode } : null;
    default: return null;
  }
}

/** One clock transition implementation for cloud authority and prepared local shows.
 * The caller owns authorization, persistence, revision checks, and broadcasting.
 * Input is never mutated. A null result means the requested transition is invalid.
 */
export function applyRundownTransport(state, command, now) {
  const items = state.items.map(item => ({...item}));
  let timer = {...state.timer};
  const iso = new Date(now).toISOString();
  const stopped = () => ({ playback:'stop', currentItemId:null, elapsed:0, startedAt:null, pausedAt:null, mode:timer.mode });
  const playing = (item, elapsed=0) => ({ playback:'play', currentItemId:item.id, elapsed, startedAt:now, pausedAt:null, mode:timer.mode });
  const markLive = item => { item.status='live'; if (!item.actualStart) item.actualStart=iso; };
  const markComplete = item => { item.status='complete'; if (!item.actualEnd) item.actualEnd=iso; };
  switch (command.type) {
    case 'timer-start': {
      const id = command.itemId ?? timer.currentItemId;
      const selected = items.find(item=>item.id===id);
      if (!selected || selected.type==='header') return null;
      if (timer.currentItemId && timer.currentItemId!==id) {
        const previous=items.find(item=>item.id===timer.currentItemId);
        if (previous) markComplete(previous);
      }
      markLive(selected);
      timer=playing(selected,timer.pausedAt ? timer.elapsed : 0);
      break;
    }
    case 'timer-resume':
      if (timer.playback==='pause') timer={...timer,playback:'play',startedAt:now,pausedAt:null};
      break;
    case 'timer-pause':
      if (timer.playback==='play') timer={...timer,elapsed:timer.elapsed+(timer.startedAt ? now-timer.startedAt : 0),playback:'pause',pausedAt:now,startedAt:null};
      break;
    case 'timer-stop': {
      const current=items.find(item=>item.id===timer.currentItemId);
      if (current) markComplete(current);
      timer=stopped();
      break;
    }
    case 'timer-next': {
      const index=items.findIndex(item=>item.id===timer.currentItemId);
      if (index>=0) markComplete(items[index]);
      const next=items.find((item,i)=>i>index && item.status!=='complete' && item.type!=='header');
      if (next) { markLive(next); timer=playing(next); }
      else timer=stopped();
      break;
    }
    case 'timer-prev': {
      const index=items.findIndex(item=>item.id===timer.currentItemId);
      let previous=index-1;
      while(previous>=0 && items[previous].type==='header') previous--;
      if (index>0 && previous>=0) {
        items[index]={...items[index],status:'upcoming',actualStart:null,actualEnd:null};
        markLive(items[previous]);
        timer=playing(items[previous]);
      }
      break;
    }
    case 'timer-adjust':
      if (timer.playback==='stop') return null;
      if (timer.playback==='play' && timer.startedAt) timer={...timer,elapsed:timer.elapsed+now-timer.startedAt-command.deltaMs,startedAt:now};
      else if (timer.playback==='pause') timer={...timer,elapsed:timer.elapsed-command.deltaMs};
      break;
    case 'timer-mode': timer.mode=command.mode; break;
  }
  return {items,timer};
}
