// The audio player's controls, in the player document `audioDocument` builds.
//
// There is a real `<audio>` behind this and no custom decoder: the element does the
// loading, buffering, seeking and playback rate, and this script only *drives* it and
// draws what it is doing. That is the whole design. A player that reimplemented
// playback would have to solve Range requests, codec support and background behaviour
// that the element already solves, and would be wrong about at least one of them.
//
// Three things are worth knowing about the way it is wired:
//
//   * The range input is the scrubber *and* the progress bar. While a drag is in
//     progress the input's value leads and playback follows on `input`; while playback
//     runs, `timeupdate` leads and the input follows. The `seeking` flag is what stops
//     the two from fighting — without it a timeupdate landing mid-drag yanks the thumb
//     back under the user's finger, which is the classic way a media scrubber feels
//     broken.
//   * `preload="metadata"` (set in the markup) means the file's header is fetched on
//     load and its duration known, so the total shows before play is pressed. That is
//     why the total can be shown at all rather than guessed at.
//   * Every mutation goes through `setPlaying`/`setProgress`, which write one attribute
//     or one CSS variable. Nothing here rebuilds a node, so there is no reflow while
//     audio plays.

  (function () {
    var audio = document.querySelector('audio');
    var play = document.querySelector('button.play');
    var seek = document.querySelector('input.seek');
    var elapsed = document.querySelector('.elapsed');
    var total = document.querySelector('.total');
    if (!audio || !play || !seek || !elapsed || !total) return;

    // 0:07, or 1:02:03 for something long enough to need hours. A rounding error at
    // the end of a track otherwise shows "1:00" for a 59.6s file.
    function clock(seconds) {
      if (!isFinite(seconds) || seconds < 0) return '--:--';
      var s = Math.round(seconds);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
    }

    var dragging = false;

    function setProgress(seconds) {
      var duration = audio.duration;
      var fraction = isFinite(duration) && duration > 0 ? seconds / duration : 0;
      fraction = Math.max(0, Math.min(1, fraction));
      // 1000 steps rather than a pixel width: a percentage keeps the control correct
      // when the drawer is resized, with no listener to keep in step.
      seek.style.setProperty('--p', (fraction * 100) + '%');
      if (!dragging) seek.value = String(Math.round(fraction * 1000));
      elapsed.textContent = clock(seconds);
    }

    function setPlaying(playing) {
      // One attribute drives both icons and the pointer handler, rather than a class
      // per icon that can drift out of step with the element's real state.
      play.setAttribute('data-playing', playing ? '1' : '0');
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      play.title = playing ? 'Pause (space)' : 'Play (space)';
    }

    function toggle() {
      // The promise rejects if the document has not been granted playback, or if the
      // source failed; there is nothing useful to do about it here, and `play`/`pause`
      // events below are what the UI follows in either case.
      if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
    }

    play.addEventListener('click', toggle);

    // Follow the element rather than our own intent: a pause can arrive from the end
    // of the file, from the media session on a phone's lock screen, or from the
    // browser stopping playback, and none of those go through `toggle`.
    audio.addEventListener('play', function () { setPlaying(true); });
    audio.addEventListener('pause', function () { setPlaying(false); });
    audio.addEventListener('ended', function () { setPlaying(false); setProgress(audio.duration); });

    audio.addEventListener('loadedmetadata', function () {
      total.textContent = clock(audio.duration);
      setProgress(0);
    });
    // A file can carry a duration of Infinity for a stream, and some containers only
    // settle it once playback starts and the browser has scanned further.
    audio.addEventListener('durationchange', function () {
      total.textContent = clock(audio.duration);
    });

    audio.addEventListener('timeupdate', function () {
      if (!dragging) setProgress(audio.currentTime);
    });

    // --- Dragging the scrubber --------------------------------------------------
    //
    // `input` fires for keyboard changes as well as drags, so this covers arrow keys
    // for free. The `dragging` flag is set on pointerdown and cleared on pointerup,
    // which is what keeps `timeupdate` from overwriting the thumb mid-drag.
    function seekTo() {
      var duration = audio.duration;
      if (!isFinite(duration) || duration <= 0) return;
      var wanted = (Number(seek.value) / 1000) * duration;
      setProgress(wanted);
      // Fast-seeking is left to the element: assigning `currentTime` during a drag is
      // what every player does, and the browser coalesces the Range requests itself.
      audio.currentTime = wanted;
    }

    seek.addEventListener('pointerdown', function () { dragging = true; });
    // `pointerup` on the input is not enough: a drag that leaves the control and is
    // released elsewhere never delivers it to the input. Listening on the window for
    // the release is what stops `dragging` from sticking true forever, which would
    // leave the progress bar frozen while the audio played on.
    window.addEventListener('pointerup', function () { dragging = false; });
    window.addEventListener('pointercancel', function () { dragging = false; });
    seek.addEventListener('input', seekTo);
    seek.addEventListener('change', seekTo);

    // --- Keys -------------------------------------------------------------------
    //
    // Space is play/pause, and the arrows nudge by five seconds — the two things every
    // media surface does. Space is not applied while the scrubber has focus, because
    // the browser already treats it as "activate this control"; the arrows are not
    // applied there either, because a focused range input uses them for its own
    // stepping, which is finer and is what a focused control should do.
    document.addEventListener('keydown', function (event) {
      if (event.target === seek) return;
      if (event.key === ' ' || event.key === 'Spacebar') {
        // The parent drawer also listens for space; this document is the one with the
        // player, so it is the one that should answer while it has focus.
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
      }
    });

    // The drawer may open this document before the metadata has arrived, or after a
    // cached load where it already has. Both are handled by asking once here.
    if (audio.readyState >= 1) {
      total.textContent = clock(audio.duration);
    }
    setPlaying(!audio.paused);

    // A failed load is worth saying out loud rather than leaving a dead button: the
    // usual causes are a corrupt file or a codec the browser lacks, and both look
    // identical to a player that simply does not respond.
    audio.addEventListener('error', function () {
      var note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'This file could not be played. It may be damaged, or in a format this browser does not support.';
      document.querySelector('.player').append(note);
      setPlaying(false);
    });
  })();
