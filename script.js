const TEMPLATE_PART = /\{\{\s*([^}]+?)\s*\}\}/g;

// Reads a value like "user.name" from the current data.
function lookup(scope, path) {
  path = path.trim();
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
  let value = scope;
  for (const part of path.split('.')) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

// Fills in every {{ name }} in a piece of text.
// If the whole text is a single {{ name }}, the raw value is returned (a number, a function, ...).
function fillIn(text, scope) {
  const whole = text.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (whole) return lookup(scope, whole[1]);
  return text.replace(TEMPLATE_PART, (_, path) => {
    const value = lookup(scope, path);
    return value == null ? '' : String(value);
  });
}

function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Applies one attribute or text value to the page, only when it changed.
function applyBinding(binding, scope, afterChildren) {
  const value = fillIn(binding.text, scope);
  if (binding.kind === 'text') {
    const str = value == null ? '' : String(value);
    if (binding.node.nodeValue !== str) binding.node.nodeValue = str;
    return;
  }
  const el = binding.el;
  const name = binding.name;
  if (name === 'value' && 'value' in el) {
    const str = value == null ? '' : String(value);
    const set = () => { if (el.value !== str) el.value = str; };
    // A <select> can only pick its value after its <option>s exist.
    if (el.tagName === 'SELECT') afterChildren.push(set); else set();
    return;
  }
  if (name === 'checked') {
    el.checked = !!value;
    return;
  }
  if (binding.last === value) return;
  binding.last = value;
  if (value == null) el.removeAttribute(name);
  else el.setAttribute(name, String(value));
}

// A View is a piece of the page plus everything in it that depends on data.
class View {
  constructor(nodes, component) {
    this.component = component;
    this.parts = [];
    this.scope = null;
    nodes.forEach((node) => this.compile(node));
  }

  compile(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.includes('{{')) {
        this.parts.push({ kind: 'text', node: node, text: node.nodeValue });
        node.nodeValue = '';
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.localName;
    if (tag === 'template' && (node.hasAttribute('data-for') || node.hasAttribute('data-if'))) {
      this.parts.push(new Block(node, this));
      return;
    }
    if (tag === 'component-slot') {
      this.parts.push(new ChildSlot(node, this));
      return;
    }

    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('data-on-')) {
        const eventName = attr.name.slice('data-on-'.length);
        const path = attr.value;
        node.removeAttribute(attr.name);
        node.addEventListener(eventName, (event) => {
          const handler = lookup(this.scope, path);
          if (typeof handler === 'function') handler(event);
        });
      } else if (attr.value.includes('{{')) {
        this.parts.push({ kind: 'attr', el: node, name: attr.name, text: attr.value, last: undefined });
        node.removeAttribute(attr.name);
      }
    }
    Array.from(node.childNodes).forEach((child) => this.compile(child));
  }

  update(scope) {
    this.scope = scope;
    const afterChildren = [];
    for (const part of this.parts) {
      if (part.update) part.update(scope);
      else applyBinding(part, scope, afterChildren);
    }
    afterChildren.forEach((fn) => fn());
  }

  destroy() {
    this.parts.forEach((part) => { if (part.destroy) part.destroy(); });
    (this.nodes || []).forEach((node) => node.remove());
  }
}

// <template data-if> and <template data-for> blocks.
class Block {
  constructor(template, parentView) {
    this.parentView = parentView;
    this.isLoop = template.hasAttribute('data-for');
    if (this.isLoop) {
      const match = template.getAttribute('data-for').match(/^\s*([\w$]+)\s+in\s+(.+)$/);
      this.itemName = match[1];
      this.listPath = match[2].trim();
    } else {
      this.conditionPath = template.getAttribute('data-if').trim();
    }
    // HTML templates keep their contents in .content; templates inside <svg> keep them as children.
    if (template.content) {
      this.source = template.content;
    } else {
      // Keep them in the template's own (inactive) document until they're filled in.
      this.source = template.ownerDocument.createDocumentFragment();
      while (template.firstChild) this.source.appendChild(template.firstChild);
    }
    this.anchor = document.createComment(this.isLoop ? ' list ' : ' if ');
    template.parentNode.replaceChild(this.anchor, template);
    this.copies = [];
  }

  makeCopy(scope) {
    const fragment = this.source.cloneNode(true);
    const view = new View(Array.from(fragment.childNodes), this.parentView.component);
    view.nodes = Array.from(fragment.childNodes);
    view.update(scope);
    this.anchor.parentNode.insertBefore(fragment, this.anchor);
    return view;
  }

  update(scope) {
    if (this.isLoop) {
      const list = lookup(scope, this.listPath) || [];
      list.forEach((item, index) => {
        const itemScope = Object.create(scope);
        itemScope[this.itemName] = item;
        itemScope.$index = index;
        if (this.copies[index]) this.copies[index].update(itemScope);
        else this.copies.push(this.makeCopy(itemScope));
      });
      while (this.copies.length > list.length) this.copies.pop().destroy();
    } else {
      const show = !!lookup(scope, this.conditionPath);
      if (show && !this.copies[0]) this.copies[0] = this.makeCopy(scope);
      else if (!show && this.copies[0]) this.copies.pop().destroy();
      else if (show) this.copies[0].update(scope);
    }
  }

  destroy() {
    this.copies.forEach((copy) => copy.destroy());
    this.copies = [];
    this.anchor.remove();
  }
}

// <component-slot name="Globe" ...> places a child component from <template id="tpl-Globe">.
class ChildSlot {
  constructor(el, parentView) {
    this.name = el.getAttribute('name');
    this.props = [];
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'name' || attr.name === 'hint-size') continue;
      this.props.push({ key: toCamel(attr.name), text: attr.value });
    }
    this.anchor = document.createComment(' ' + this.name + ' ');
    el.parentNode.replaceChild(this.anchor, el);
    this.child = null;
  }

  update(scope) {
    const props = {};
    this.props.forEach((p) => { props[p.key] = fillIn(p.text, scope); });
    if (!this.child) {
      const ChildClass = COMPONENTS[this.name];
      this.child = new ChildClass(props);
      const fragment = document.getElementById('tpl-' + this.name).content.cloneNode(true);
      this.child._view = new View(Array.from(fragment.childNodes), this.child);
      this.child._view.nodes = Array.from(fragment.childNodes);
      this.child._render();
      this.anchor.parentNode.insertBefore(fragment, this.anchor);
      if (this.child.componentDidMount) this.child.componentDidMount();
    } else {
      const previous = this.child.props;
      this.child.props = props;
      this.child._render();
      if (this.child.componentDidUpdate) this.child.componentDidUpdate(previous);
    }
  }

  destroy() {
    if (this.child) {
      if (this.child.componentWillUnmount) this.child.componentWillUnmount();
      this.child._view.destroy();
      this.child._view = null; // stops any redraw that was already scheduled
      this.child = null;
    }
    this.anchor.remove();
  }
}

// Base class for App and Globe: holds state and redraws when it changes.
class Component {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }

  // Changes some state and redraws on the next frame.
  setState(changes) {
    Object.assign(this.state, typeof changes === 'function' ? changes(this.state) : changes);
    this._scheduleRender();
  }

  forceUpdate() {
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._renderQueued || !this._view) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  _render() {
    if (this._view) this._view.update(this.renderVals());
  }
}

// Turns the HTML inside `container` into a live page driven by `ComponentClass`.
function mount(container, ComponentClass) {
  const app = new ComponentClass({});
  app._view = new View(Array.from(container.childNodes), app);
  app._render();
  container.hidden = false;
  if (app.componentDidMount) app.componentDidMount();
  return app;
}


/* ---------------------------------------------------------------------
   2. APP
   All of the app's data and behavior. renderVals() returns every value
   and function that index.html uses.

   The starting numbers, feed items, stories and missions are written
   right here in the code. In the real app, load them from your backend
   (for example Firebase or Supabase) instead.
   --------------------------------------------------------------------- */

class App extends Component {
  constructor(props) {
    super(props);
    this.state = {
      counts: { Brazil: 82418, Colombia: 26898, Germany: 41281, India: 97053, Japan: 33914, Kenya: 18757, Lebanon: 9332, 'United States': 120582 },
      base: 1284998 - (82418 + 26898 + 41281 + 97053 + 33914 + 18757 + 9332 + 120582),
      feedPos: 0,
      tick: 0,
      missionShown: false,
      pace: 3,
      week: [10, 1, 3],
      doneSet: {},
      swapCursor: 0,
      filter: 'All',
      showAll: false,
      done: false,
      country: '',
      selected: 'Colombia',
      home: 'Colombia',
      onboarding: false,
      step: 1,
      obCountry: '',
      obError: false,
      obFlipped: false,
      view: 'home',
      menuOpen: false,
      myActs: 0,
      inspired: {},
      share: null,
      sight: null,
      inviteOpen: false,
      copied: false,
      joined: 0,
      report: null,
      reported: {},
      forgotSent: false,
      authTab: 'login',
      pw: '',
      showPw: false,
      authTried: false,
      authBurst: false,
      diceSpins: 0,
      socialNote: '',
      sights: [],
      scrolled: false,
      storyIdx: 0,
      storyFade: false,
      activeSec: 'top',
      myStories: [],
      tab: 'home',
      reminder: false,
      reminderDay: 'Sunday',
      loggedIn: false,
      email: '',
      codename: '',
      deckOffset: 0,
      releasing: false,
      starSel: -1,
      readPulse: 0,
      flipped: {}
    };
    this.pool = [
      { who: 'Quiet Heron', place: 'Tokyo, Japan', country: 'Japan', text: 'Helped a lost tourist find the right train.' },
      { who: 'Sunny Baobab', place: 'Nairobi, Kenya', country: 'Kenya', text: 'Checked in on an elderly neighbor who lives alone.' },
      { who: 'Calm Jaguar', place: 'São Paulo, Brazil', country: 'Brazil', text: 'Chose to listen instead of arguing with a coworker.' },
      { who: 'Bright Condor', place: 'Medellín, Colombia', country: 'Colombia', text: 'Shared lunch with a new classmate.' },
      { who: 'Kind Linden', place: 'Berlin, Germany', country: 'Germany', text: 'Learned to say thank you in a neighbor’s language.' },
      { who: 'Gentle Cedar', place: 'Beirut, Lebanon', country: 'Lebanon', text: 'Carried groceries up the stairs for a stranger.' },
      { who: 'Warm Monsoon', place: 'Mumbai, India', country: 'India', text: 'Thanked a street sweeper by name.' },
      { who: 'Brave Harbor', place: 'Hoboken, United States', country: 'United States', text: 'Wrote a kind note to a teacher.' }
    ];
    this.stories = [
      { who: 'Gentle Cedar', place: 'Lebanon', value: 'Generosity', text: 'My neighbor’s elevator broke for a week, so I carried her groceries up six floors every evening. By Friday she was teaching me to make kibbeh.' },
      { who: 'Quiet Heron', place: 'Japan', value: 'Gratitude', text: 'I’d passed the cleaner at my train station every morning for two years and never knew her name. Now I do. She laughed when I thanked her.' },
      { who: 'Bright Condor', place: 'Colombia', value: 'Connection', text: 'A new student ate lunch alone every day, so I sat with him. We support rival football teams, and now we argue about it happily.' },
      { who: 'Kind Linden', place: 'Germany', value: 'Understanding', text: 'I asked my uncle why he sees things the way he does, and only listened. We still disagree, but it was our first calm conversation in years.' },
      { who: 'Sunny Baobab', place: 'Kenya', value: 'Courage', text: 'I apologized to my sister for something I said three years ago. She cried, I cried, and then she made us tea.' },
      { who: 'Brave Harbor', place: 'United States', value: 'Empathy', text: 'I wrote to my old art teacher to say she changed my life. She wrote back that she still keeps every student’s first drawing, including mine.' }
    ];
    this.dots = ['#f0a6d8', '#b9a6f5', '#8fc8f5', '#9ee8cf', '#f3e9a0'];
    this.missions = [{"day": 1, "title": "Reach Across the Divide", "desc": "Start a genuine conversation with someone whose beliefs or worldview differ from yours. Ask questions to understand them, not convince them.", "tags": ["Courage", "Understanding"]}, {"day": 2, "title": "The Forgotten Friend", "desc": "Reach out to someone you’ve lost touch with and tell them why you still value them.", "tags": ["Connection", "Courage"]}, {"day": 3, "title": "The Invisible Hero", "desc": "Find someone whose work is often overlooked. Take time to learn their name and thank them for something specific.", "tags": ["Gratitude", "Empathy"]}, {"day": 4, "title": "Give Someone Your Time", "desc": "Spend 15 uninterrupted minutes with someone who could use company or a listening ear.", "tags": ["Generosity", "Empathy"]}, {"day": 5, "title": "The Apology That Matters", "desc": "Think of a mistake you’ve made. If it’s appropriate and safe, take responsibility and offer a sincere apology.", "tags": ["Courage", "Understanding"]}, {"day": 6, "title": "A Stranger’s Story", "desc": "Have a respectful conversation with someone outside your usual circle and learn something meaningful about their life.", "tags": ["Connection", "Understanding"]}, {"day": 7, "title": "The Unspoken Compliment", "desc": "Tell someone something you genuinely admire about them that you’ve never had the courage to say.", "tags": ["Courage", "Gratitude"]}, {"day": 8, "title": "Do the Hard Kind Thing", "desc": "Offer meaningful help to someone, even if it means giving up a little of your free time.", "tags": ["Generosity", "Empathy"]}, {"day": 9, "title": "Listen Without Defending", "desc": "During a disagreement, genuinely listen and summarize the other person’s perspective before sharing your own.", "tags": ["Understanding", "Empathy"]}, {"day": 10, "title": "Include the Outsider", "desc": "Invite someone who is often left out to join you in an activity or conversation.", "tags": ["Connection", "Courage"]}, {"day": 11, "title": "Challenge Your Assumptions", "desc": "Identify a group you hold assumptions about. Seek out a firsthand account that challenges your perspective.", "tags": ["Understanding", "Courage"]}, {"day": 12, "title": "Make Someone Feel Valued", "desc": "Write a thoughtful message explaining three specific things you appreciate about someone.", "tags": ["Gratitude", "Generosity"]}, {"day": 13, "title": "A Gift Without Recognition", "desc": "Do something genuinely helpful for someone without telling anyone or expecting credit.", "tags": ["Generosity"]}, {"day": 14, "title": "Turn Anger Into Curiosity", "desc": "Think of someone whose opinion frustrates you. Ask them one thoughtful question and listen to their answer.", "tags": ["Understanding", "Courage"]}, {"day": 15, "title": "The Courage to Stand Up", "desc": "When you witness someone being unfairly excluded or treated disrespectfully, support them in a safe and constructive way.", "tags": ["Courage", "Empathy"]}, {"day": 16, "title": "Give More Than Expected", "desc": "When someone asks you for reasonable help today, offer a little more than they expected, within your limits.", "tags": ["Generosity"]}, {"day": 17, "title": "Make the First Move", "desc": "Reach out to someone after a minor disagreement and offer a respectful opportunity to reconnect.", "tags": ["Courage", "Connection"]}, {"day": 18, "title": "An Hour for Someone Else", "desc": "Dedicate part of your day to helping a neighbor, community group, or someone who needs support.", "tags": ["Generosity", "Empathy"]}, {"day": 19, "title": "Celebrate Someone You Envy", "desc": "Genuinely congratulate someone whose success has made you feel jealous or insecure.", "tags": ["Courage", "Gratitude"]}, {"day": 20, "title": "Find the Humanity", "desc": "Learn the personal story of someone whose experiences are very different from your own.", "tags": ["Understanding", "Empathy"]}, {"day": 21, "title": "Break a Cycle of Negativity", "desc": "When a conversation turns into gossip or hostility, gently redirect it toward understanding or something constructive.", "tags": ["Courage", "Understanding"]}, {"day": 22, "title": "Give Someone a Voice", "desc": "In a group discussion, help make room for someone whose perspective is being overlooked.", "tags": ["Empathy", "Courage"]}, {"day": 23, "title": "A Letter That Matters", "desc": "Write a heartfelt letter to someone who made a difference in your life, and send it.", "tags": ["Gratitude", "Generosity"]}, {"day": 24, "title": "Trade Judgment for Understanding", "desc": "Think of someone you’ve judged unfairly. Find a respectful way to better understand their circumstances.", "tags": ["Understanding", "Empathy"]}, {"day": 25, "title": "Help Without Being Asked", "desc": "Notice a real need in your community and take one concrete step to address it.", "tags": ["Generosity", "Courage"]}, {"day": 26, "title": "The Difficult Thank You", "desc": "Thank someone you have a complicated relationship with for something genuinely positive they’ve done, if appropriate.", "tags": ["Gratitude", "Courage"]}, {"day": 27, "title": "Choose Cooperation", "desc": "Work with someone you don’t normally collaborate with to accomplish a shared goal.", "tags": ["Connection", "Understanding"]}, {"day": 28, "title": "Be the First to Show Kindness", "desc": "Show genuine kindness to someone who has been distant or unfriendly, without expecting them to reciprocate.", "tags": ["Courage", "Generosity"]}, {"day": 29, "title": "Make Peace Visible", "desc": "Share a true story of kindness you witnessed, giving credit and getting permission where appropriate.", "tags": ["Gratitude", "Connection"]}, {"day": 30, "title": "Create a Ripple Across Borders", "desc": "Connect with someone from another country or culture and exchange stories about what kindness means to you.", "tags": ["Understanding", "Connection"]}, {"day": 31, "title": "Start a Chain of Peace", "desc": "Complete a meaningful act of kindness, invite three people to do their own, and ask them to pass it forward.", "tags": ["Generosity", "Courage"]}];
    this.tagColors = { Courage: "#f0a6d8", Understanding: "#b9a6f5", Connection: "#8fc8f5", Gratitude: "#f3e9a0", Empathy: "#9ee8cf", Generosity: "#f6c3a8" };

  }
  componentDidMount() {
    if (typeof window !== 'undefined') {
      this.onScroll = () => {
        const y = window.scrollY || 0;
        const ids = this.state.loggedIn ? ['home', 'world', 'stories', 'missions'] : ['top', 'world', 'missions', 'join'];
        let act = ids[0];
        ids.forEach((id) => { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= 160) act = id; });
        const scrolled = y > 12;
        const upd = {};
        if (scrolled !== this.state.scrolled) upd.scrolled = scrolled;
        if (act !== this.state.activeSec) upd.activeSec = act;
        if (this.state.loggedIn && this.state.view === 'home' && ['home', 'world', 'stories', 'missions'].indexOf(act) !== -1 && act !== this.state.tab) upd.tab = act;
        if (Object.keys(upd).length) this.setState(upd);
      };
      window.addEventListener('scroll', this.onScroll, { passive: true });
    }
    this.storyTimer = setInterval(() => this.rotateStory(1), 7000);
    this.timer = setInterval(() => {
      const next = this.pool[(this.state.feedPos + 5) % this.pool.length];
      const counts = Object.assign({}, this.state.counts);
      counts[next.country] = counts[next.country] + 1 + Math.floor(Math.random() * 3);
      this.setState({ counts: counts, feedPos: (this.state.feedPos + 1) % this.pool.length, tick: this.state.tick + 1 });
    }, 3200);
  }
  rotateStory(dir, to) {
    this.setState({ storyFade: true });
    setTimeout(() => {
      const n = this.stories.length;
      this.setState({ storyIdx: to !== undefined ? to : (this.state.storyIdx + dir + n) % n, storyFade: false });
    }, 350);
  }
  componentWillUnmount() { clearInterval(this.timer); clearInterval(this.storyTimer); if (this.onScroll && typeof window !== 'undefined') window.removeEventListener('scroll', this.onScroll); }
  renderVals() {
    const s = this.state;
    const names = Object.keys(s.counts).sort();
    let sum = 0;
    names.forEach((n) => { sum += s.counts[n]; });
    const geo = {
      Brazil: { lat: -10, lon: -52, color: '#9ee8cf', glow: 'rgba(158, 232, 207, 0.35)', side: 'right' },
      Colombia: { lat: 4, lon: -73, color: '#f0a6d8', glow: 'rgba(240, 166, 216, 0.4)', side: 'left' },
      Germany: { lat: 51, lon: 10, color: '#b9a6f5', glow: 'rgba(185, 166, 245, 0.35)', side: 'left' },
      India: { lat: 21, lon: 78, color: '#f3e9a0', glow: 'rgba(243, 233, 160, 0.3)', side: 'right' },
      Japan: { lat: 36, lon: 138, color: '#8fc8f5', glow: 'rgba(143, 200, 245, 0.35)', side: 'left' },
      Kenya: { lat: 0, lon: 38, color: '#f0a6d8', glow: 'rgba(240, 166, 216, 0.35)', side: 'right' },
      Lebanon: { lat: 34, lon: 36, color: '#9ee8cf', glow: 'rgba(158, 232, 207, 0.35)', side: 'right' },
      'United States': { lat: 39, lon: -98, color: '#8fc8f5', glow: 'rgba(143, 200, 245, 0.35)', side: 'right' }
    };
    const extra = {
      Argentina: [-34, -64, 'right'], Australia: [-25, 134, 'right'], Canada: [58, -106, 'right'], Egypt: [26, 30, 'left'], France: [46, 2, 'left'],
      Ghana: [8, -1, 'left'], Indonesia: [-2, 118, 'right'], Italy: [42, 12, 'right'], Mexico: [23, -102, 'left'], Morocco: [32, -6, 'left'],
      Nigeria: [9, 8, 'left'], Peru: [-9, -75, 'left'], Philippines: [12, 122, 'right'], 'South Africa': [-29, 24, 'right'], 'South Korea': [36, 128, 'left'],
      Spain: [40, -4, 'left'], 'United Kingdom': [54, -2, 'left'], Vietnam: [16, 107, 'left']
    };
    const pal = [['#f0a6d8', 'rgba(240, 166, 216, 0.4)'], ['#b9a6f5', 'rgba(185, 166, 245, 0.35)'], ['#8fc8f5', 'rgba(143, 200, 245, 0.35)'], ['#9ee8cf', 'rgba(158, 232, 207, 0.35)'], ['#f3e9a0', 'rgba(243, 233, 160, 0.3)']];
    Object.keys(extra).forEach((k, i) => { if (!geo[k]) geo[k] = { lat: extra[k][0], lon: extra[k][1], side: extra[k][2], color: pal[i % 5][0], glow: pal[i % 5][1] }; });
    const countryOptions = Object.keys(geo).sort().map((k) => ({ v: k }));
    const home = s.home;
    const sel = s.selected || home;
    const latestFor = (n) => { const m = this.pool.filter((x) => x.country === n)[0]; return m ? m.text : 'An act of kindness.'; };
    const selInfo = {
      name: sel, tag: sel === home ? 'You’re here' : 'Selected country',
      countStr: s.counts[sel].toLocaleString('en-US'), color: geo[sel].color, latest: latestFor(sel)
    };
    const tagList = (m) => m.tags.map((t) => ({ name: t, style: 'display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 600; color: #1d1b3c; background: ' + this.tagColors[t] }));
    const self = this;
    const goLogin = (tab) => { this.setState({ authTab: tab === 'create' ? 'create' : 'login', authTried: false, socialNote: '' }); if (typeof document !== 'undefined') { const el = document.getElementById('login'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => { const f = document.getElementById('email'); if (f) f.focus(); }, 500); } };
    const nameFrom = (em) => { const n = (em || '').split('@')[0].split(/[^A-Za-z]+/).filter(Boolean)[0] || ''; return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Friend'; };
    const ms = this.missions;
    const week = s.week;
    const doneCount = week.filter((i) => s.doneSet[i]).length;
    const nextI = week.filter((i) => !s.doneSet[i])[0];
    const firstUnused = (exclude) => { for (let k = 0; k < ms.length; k++) { const c = (s.swapCursor + 11 + k) % ms.length; if (exclude.indexOf(c) === -1) return c; } return 0; };
    const fillWeek = (n, base) => { const w = base.slice(0, n); let k = 0; while (w.length < n && k < 62) { const c = (10 + k * 3) % ms.length; if (w.indexOf(c) === -1) w.push(c); k++; } return w; };
    const curM = nextI !== undefined ? ms[nextI] : ms[week[0] !== undefined ? week[0] : 0];
    const curInfo = { label: nextI !== undefined ? 'Your next mission · ' + (doneCount + 1) + ' of ' + s.pace + ' this week' : 'Week complete', title: curM.title, desc: curM.desc, tags: tagList(curM) };
    const paceDefs = [[1, 'Gentle start'], [2, 'Easy rhythm'], [3, 'Steady'], [5, 'Committed'], [7, 'Every day']];
    const paces = paceDefs.map((d) => {
      const on = s.pace === d[0];
      return {
        n: d[0], label: d[1], pressed: on ? 'true' : 'false',
        style: 'font: inherit; min-height: 110px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border-radius: 20px; cursor: pointer; ' + (on ? 'color: #1d1b3c; border: 0; background: linear-gradient(135deg, #f0a6d8, #b9a6f5 30%, #8fc8f5 55%, #9ee8cf 78%, #f3e9a0); box-shadow: 0 14px 34px -14px rgba(155, 125, 235, 0.7);' : 'color: #1d1b3c; background: rgba(255, 255, 255, 0.72); border: 2px solid rgba(29, 27, 60, 0.12);'),
        pick: () => self.setState({ pace: d[0], week: fillWeek(d[0], s.week) })
      };
    });
    const weekCards = week.map((i) => {
      const m = ms[i]; const isDone = !!s.doneSet[i];
      return {
        title: m.title, desc: m.desc, tags: tagList(m), pressed: isDone ? 'true' : 'false',
        checkLabel: (isDone ? 'Mark not done: ' : 'Mark done: ') + m.title,
        removeLabel: 'Remove from this week: ' + m.title,
        rowStyle: 'display: flex; gap: 18px; align-items: flex-start; padding: 22px; border-radius: 18px; ' + (isDone ? 'background: linear-gradient(90deg, #f7e1f1, #e3e0fb 35%, #d6ecfa 65%, #d8f5ea);' : 'background: #f6f5fc;'),
        checkStyle: 'flex: none; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; ' + (isDone ? 'background: #1d1b3c; color: #ffffff; border: 2px solid #1d1b3c;' : 'background: #ffffff; color: transparent; border: 2px solid rgba(29, 27, 60, 0.35);'),
        toggle: () => { const d = Object.assign({}, s.doneSet); const counts = Object.assign({}, s.counts); let acts = s.myActs; let sh = s.share; if (d[i]) { delete d[i]; acts = Math.max(0, acts - 1); } else { d[i] = true; counts[s.home] = (counts[s.home] || 0) + 1; acts += 1; sh = { idx: i, from: 'week', text: '', sent: false, photo: null }; } self.setState({ doneSet: d, counts: counts, myActs: acts, share: sh }); },
        remove: () => self.setState({ week: s.week.filter((x) => x !== i) })
      };
    });
    const emptySlots = []; for (let k = week.length; k < s.pace; k++) emptySlots.push({ k: k });
    const progressBars = []; for (let k = 0; k < s.pace; k++) progressBars.push({ style: 'flex: 1 1 0; height: 10px; border-radius: 999px; background: ' + (k < doneCount ? 'linear-gradient(90deg, #f0a6d8, #b9a6f5, #8fc8f5, #9ee8cf)' : 'rgba(29, 27, 60, 0.1)') });
    const progressText = doneCount === s.pace ? 'All ' + s.pace + ' done. Your ripples are out in the world.' : doneCount + ' of ' + s.pace + ' done. No rush.';
    const values = ['All', 'Courage', 'Understanding', 'Connection', 'Gratitude', 'Empathy', 'Generosity'];
    const filters = values.map((v) => {
      const on = s.filter === v;
      return {
        name: v, pressed: on ? 'true' : 'false',
        style: 'font: inherit; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 999px; cursor: pointer; ' + (on ? 'background: #1d1b3c; color: #ffffff; border: 2px solid #1d1b3c;' : 'background: rgba(255, 255, 255, 0.7); color: #1d1b3c; border: 2px solid rgba(29, 27, 60, 0.18);'),
        dotStyle: v === 'All' ? 'display: none' : 'width: 10px; height: 10px; border-radius: 50%; background: ' + this.tagColors[v],
        pick: () => self.setState({ filter: v })
      };
    });
    const matched = ms.map((m, i) => ({ m: m, i: i })).filter((o) => s.filter === 'All' || o.m.tags.indexOf(s.filter) !== -1);
    const full = week.length >= s.pace;
    const shown = s.showAll ? matched : matched.slice(0, 6);
    const library = shown.map((o) => {
      const inWeek = week.indexOf(o.i) !== -1;
      const label = !s.loggedIn ? 'Log in to add' : (inWeek ? 'In your week' : (full ? 'Your week is full' : 'Add to my week'));
      const active = !s.loggedIn || (!inWeek && !full);
      return {
        title: o.m.title, desc: o.m.desc, tags: tagList(o.m), btnLabel: label,
        btnStyle: 'font: inherit; align-self: flex-start; margin-top: 6px; min-height: 44px; padding: 0 20px; border-radius: 999px; font-size: 15px; font-weight: 600; ' + (active ? 'cursor: pointer; background: #1d1b3c; color: #ffffff; border: 2px solid #1d1b3c;' : 'cursor: default; background: transparent; color: #3d3a63; border: 2px solid rgba(29, 27, 60, 0.18);'),
        add: () => { if (!s.loggedIn) { goLogin(); return; } if (active) self.setState({ week: s.week.concat([o.i]) }); }
      };
    });
    const filterNote = (s.filter === 'All' ? ms.length + ' missions' : matched.length + ' missions that build ' + s.filter.toLowerCase()) + '. Pick the ones that speak to you.';
    const examples = [0, 2, 21, 26, 8, 12, 6, 1, 22, 29, 3, 18];
    const opened = s.flipped;
    const openN = [0, 1, 2, 3].filter((k) => opened[k]).length;
    const letters = [0, 1, 2, 3].map((k) => {
      const m = this.missions[examples[(s.deckOffset * 4 + k) % examples.length]];
      const v = m.tags[0]; const col = this.tagColors[v];
      const op = !!opened[k];
      return {
        title: m.title, desc: m.desc, value: v, color: col, pressed: op ? 'true' : 'false',
        code: 'Letter 0' + (k + 1), hiddenLetter: op ? 'false' : 'true',
        label: op ? 'Opened · ' + v : 'Sealed · ' + v,
        aria: op ? 'Letter ' + (k + 1) + ', ' + v + ', open: ' + m.title + '. ' + m.desc + ' Tap to seal it again.' : 'Sealed ' + v + ' letter. Tap to break the seal.',
        floatStyle: 'width: 240px; height: ' + (op ? 520 : 230) + 'px; position: relative; transition: height .8s cubic-bezier(.2, .8, .2, 1); animation-delay: ' + (k * -1.5) + 's',
        groupStyle: 'position: absolute; inset: 0; perspective: 900px; transition: transform .8s cubic-bezier(.2, .8, .2, 1); transform: translateY(' + (op ? 0 : -300) + 'px)',
        flapFill: op ? 'rgba(143, 200, 245, 0.10)' : 'rgba(30, 26, 72, 0.92)',
        flapStyle: 'position: absolute; left: 0; top: 320px; width: 240px; height: 96px; transform-origin: 50% 1px; transform: rotateX(' + (op ? 180 : 0) + 'deg); ' + (op ? 'z-index: 1; transition: transform .55s ease, z-index 0s .28s;' : 'z-index: 5; transition: transform .55s ease .25s, z-index 0s .5s;'),
        letterStyle: 'position: absolute; left: 10px; width: 220px; height: 296px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 18px 18px 20px; border-radius: 12px; border: 1px solid ' + col + '; box-shadow: 0 0 28px -6px ' + col + ', inset 0 0 24px rgba(143, 200, 245, 0.1); top: ' + (op ? 14 : 334) + 'px; opacity: ' + (op ? 1 : 0) + '; visibility: ' + (op ? 'visible' : 'hidden') + '; transition: top .85s cubic-bezier(.2, .8, .2, 1) ' + (op ? '.35s' : '0s') + ', opacity .5s ease ' + (op ? '.45s' : '0s') + ', visibility 0s ' + (op ? '.35s' : '.5s'),
        tagStyle: 'padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #0e0c26; background: ' + col,
        sealFill: col,
        sealStyle: 'position: absolute; left: 92px; top: 384px; width: 56px; height: 56px; z-index: 6; pointer-events: none; filter: drop-shadow(0 0 12px ' + col + '); transition: transform .45s ease, opacity .45s ease, filter .45s ease; ' + (op ? 'transform: scale(1.9) rotate(25deg); opacity: 0; filter: blur(6px);' : 'transform: none; opacity: 1;'),
        labelStyle: 'position: absolute; left: 50%; top: 494px; transform: translateX(-50%); white-space: nowrap; font: 600 11px Inter, system-ui, sans-serif; letter-spacing: 0.16em; text-transform: uppercase; padding: 4px 10px; border-radius: 6px; pointer-events: none; transition: color .3s; ' + (op ? 'color: #0e0c26; background: ' + col + ';' : 'color: #a9bfdc; background: rgba(14, 12, 38, 0.7); border: 1px solid rgba(143, 200, 245, 0.25);'),
        toggle: () => { const f = Object.assign({}, s.flipped); f[k] = !f[k]; self.setState({ flipped: f }); }
      };
    });
    const adj = ['Brave', 'Gentle', 'Quiet', 'Sunny', 'Kind', 'Bright', 'Calm', 'Warm', 'Bold', 'Soft', 'Golden', 'Curious'];
    const nouns = ['Otter', 'Comet', 'Heron', 'Lantern', 'Maple', 'Harbor', 'Firefly', 'Willow', 'Dolphin', 'Meadow', 'Sparrow', 'Ripple'];
    const toTop = () => { if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const scrollToId = (id) => { setTimeout(() => { if (typeof document !== 'undefined') { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth' }); } }, 120); };
    const finish = (target) => { this.setState({ view: 'home', tab: target === 'world' ? 'world' : 'missions', share: null, onboarding: false, loggedIn: true, selected: s.home, missionShown: false, done: false }); scrollToId(target); };
    const startSignup = (e) => { if (e && e.preventDefault) e.preventDefault(); this.setState({ obCountry: s.country || s.obCountry, obFlipped: false }); goLogin('create'); };
    const firstI = s.week[0] !== undefined ? s.week[0] : 10;
    const fm = this.missions[firstI];
    const fcol = this.tagColors[fm.tags[0]];
    const fface = 'position: absolute; inset: 0; box-sizing: border-box; border-radius: 26px; backface-visibility: hidden; -webkit-backface-visibility: hidden; display: flex; flex-direction: column; box-shadow: 0 30px 60px -28px rgba(29, 27, 60, 0.55); border: 3px solid ' + fcol + '; ';
    const first = {
      title: fm.title, desc: fm.desc, tags: tagList(fm), pressed: s.obFlipped ? 'true' : 'false',
      aria: s.obFlipped ? fm.title + ': ' + fm.desc : 'Your first mission, face down. Tap to open.',
      innerStyle: 'position: relative; display: block; width: 100%; height: 100%; transform-style: preserve-3d; transition: transform .8s cubic-bezier(.2, .8, .2, 1); transform: rotateY(' + (s.obFlipped ? 180 : 0) + 'deg)',
      backStyle: fface + 'align-items: center; justify-content: center; gap: 18px; padding: 28px; background: linear-gradient(150deg, #f7e1f1 0%, #e3e0fb 30%, #d6ecfa 55%, #d8f5ea 78%, #fbf0cf 100%)',
      frontStyle: fface + 'transform: rotateY(180deg); text-align: left; justify-content: center; gap: 18px; padding: 32px; background: #ffffff'
    };
    const stepBars = [1, 2, 3, 4].map((k) => ({ style: 'flex: 1 1 0; height: 6px; border-radius: 999px; background: ' + (k <= s.step ? 'linear-gradient(90deg, #f0a6d8, #b9a6f5, #8fc8f5, #9ee8cf)' : 'rgba(29, 27, 60, 0.12)') }));
    const hr = new Date().getHours();
    const greeting = hr < 12 ? 'Good morning' : (hr < 18 ? 'Good afternoon' : 'Good evening');
    const ringC = 2 * Math.PI * 50;
    const ringFrac = s.pace ? Math.min(1, doneCount / s.pace) : 0;
    const tagCount = {};
    Object.keys(s.doneSet).forEach((k) => { this.missions[k].tags.forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }); });
    const topTags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]);
    const go = (id) => { this.setState({ view: 'home', menuOpen: false, tab: id }); scrollToId(id); };
    const stories = this.stories.map((st, k) => ({ st: st, k: k })).filter((o) => !s.reported['story' + o.k]).map((o) => {
      const st = o.st, k = o.k;
      const on = !!s.inspired[k];
      const col = this.tagColors[st.value];
      return {
        who: st.who, place: st.place, value: st.value, text: st.text, color: col, pressed: on ? 'true' : 'false',
        btnLabel: on ? 'Inspired' : 'This inspires me',
        cardStyle: 'flex: 0 0 min(360px, 82vw); scroll-snap-align: start; box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; padding: 28px; border-radius: 26px; background: #ffffff; box-shadow: 0 24px 50px -32px rgba(29, 27, 60, 0.45); border-top: 5px solid ' + col,
        tagStyle: 'padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 600; color: #1d1b3c; background: ' + col,
        btnStyle: 'font: inherit; align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 999px; font-size: 15px; font-weight: 600; cursor: pointer; ' + (on ? 'color: #1d1b3c; border: 0; background: linear-gradient(90deg, #f0a6d8, #b9a6f5, #8fc8f5, #9ee8cf);' : 'color: #1d1b3c; background: transparent; border: 2px solid rgba(29, 27, 60, 0.2);'),
        toggle: () => { const m = Object.assign({}, s.inspired); m[k] = !m[k]; self.setState({ inspired: m }); },
        report: () => openReport('story' + k, 'this story by ' + st.who),
        reportLabel: 'Report this story by ' + st.who
      };
    });
    const scrollStories = (dir) => { if (typeof document === 'undefined') return; const el = document.getElementById('storyrow'); if (el) el.scrollBy({ left: dir * 380, behavior: 'smooth' }); };
    const sh = s.share;
    const shareMission = sh ? this.missions[sh.idx] : null;
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const left = Math.max(0, s.pace - doneCount);
    const tabKeys = ['home', 'world', 'missions', 'stories', 'profile'];
    const tabVals = {};
    tabKeys.forEach((k) => {
      const on = s.tab === k;
      tabVals['tab_' + k] = () => { if (k === 'profile') { self.setState({ view: 'profile', tab: 'profile' }); toTop(); } else if (k === 'home') { self.setState({ view: 'home', tab: 'home' }); toTop(); } else { go(k); } };
      tabVals['cur_' + k] = on ? 'page' : 'false';
      tabVals['tabStyle_' + k] = 'font: inherit; flex: 1 1 0; min-height: 56px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font-size: 12px; font-weight: 600; border: 0; border-radius: 16px; cursor: pointer; ' + (on ? 'color: #1d1b3c; background: linear-gradient(135deg, #f0a6d8, #b9a6f5 30%, #8fc8f5 55%, #9ee8cf 78%, #f3e9a0);' : 'color: #dcd8f2; background: transparent;');
    });
    const navVals = {};
    ['home', 'world', 'missions', 'stories', 'why'].forEach((k) => {
      const on = s.loggedIn ? (s.view === 'home' && s.tab === k) : s.activeSec === k;
      navVals['nl_' + k] = 'navlink' + (on ? ' active' : '');
      navVals['ac_' + k] = on ? 'location' : 'false';
    });
    navVals.headerClass = 'navbar' + (s.scrolled ? ' scrolled' : '') + (s.menuOpen ? ' menuopen' : '');
    const fst = this.stories[s.storyIdx];
    const featured = { text: fst.text, who: fst.who, place: fst.place, value: fst.value, tagStyle: 'padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; color: #1d1b3c; background: ' + this.tagColors[fst.value] };
    const storyDots = this.stories.map((x, k) => ({
      aria: 'Show story ' + (k + 1) + ' of ' + this.stories.length,
      current: k === s.storyIdx ? 'true' : 'false',
      style: 'display: block; height: 8px; border-radius: 999px; transition: width .3s, background .3s; ' + (k === s.storyIdx ? 'width: 26px; background: #5b3fd6;' : 'width: 8px; background: rgba(29, 27, 60, 0.25);'),
      pick: () => { clearInterval(self.storyTimer); self.storyTimer = setInterval(() => self.rotateStory(1), 7000); self.rotateStory(0, k); }
    }));
    const pickPhoto = (e, cb) => { const f = e && e.target && e.target.files && e.target.files[0]; if (!f) return; let url = ''; try { url = URL.createObjectURL(f); } catch (err) { url = ''; } if (url) cb(url); };
    const sg = s.sight;
    const feelNames = [['Calm', '#9ee8cf'], ['Happy', '#f3e9a0'], ['Proud', '#f0a6d8'], ['Grateful', '#f6c3a8'], ['Hopeful', '#8fc8f5'], ['Nervous', '#b9a6f5']];
    const feelings = feelNames.map((f) => {
      const on = !!(s.share && s.share.feeling === f[0]);
      return {
        name: f[0], pressed: on ? 'true' : 'false',
        style: 'font: inherit; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 999px; font-size: 15px; font-weight: 600; cursor: pointer; color: #1d1b3c; ' + (on ? 'background: #ffffff; border: 2px solid #1d1b3c;' : 'background: rgba(255, 255, 255, 0.6); border: 2px solid transparent;'),
        dot: 'width: 10px; height: 10px; border-radius: 50%; background: ' + f[1],
        pick: () => self.setState({ share: Object.assign({}, self.state.share, { feeling: on ? null : f[0] }) })
      };
    });
    const cname = s.codename.trim() || nameFrom(s.email);
    const slug = cname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend';
    const inviteLink = 'pop.app/join/' + slug;
    const joinedDots = []; for (let k = 0; k < Math.min(s.joined, 6); k++) joinedDots.push({ style: 'width: 22px; height: 22px; border-radius: 50%; background: ' + ['#f0a6d8', '#b9a6f5', '#8fc8f5', '#9ee8cf', '#f3e9a0', '#f6c3a8'][k] });
    const rp = s.report;
    const reasons = ['Not kind or respectful', 'Shares private information', 'Spam or advertising', 'Something else'];
    const reportReasons = reasons.map((r, k) => ({ label: r, checked: !!(rp && rp.reason === k), pick: () => self.setState({ report: Object.assign({}, self.state.report, { reason: k, err: false }) }) }));
    const openReport = (key, what) => { self.setState({ report: { key: key, what: what, reason: -1, sent: false, err: false } }); scrollToId('report'); };
    const isCreate = s.authTab === 'create';
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.email.trim());
    const pwv = s.pw;
    let pwScore = 0;
    if (pwv.length >= 8) pwScore++;
    if (/[A-Z]/.test(pwv) && /[a-z]/.test(pwv)) pwScore++;
    if (/[0-9]/.test(pwv)) pwScore++;
    if (/[^A-Za-z0-9]/.test(pwv)) pwScore++;
    if (pwv.length > 0 && pwv.length < 8) pwScore = Math.min(pwScore, 1);
    const pwOk = isCreate ? (pwv.length >= 8 && pwScore >= 2) : pwv.length > 0;
    const countryOk = !!s.obCountry;
    const fieldCls = (ok, filled) => 'field' + (s.authTried && !ok ? ' bad' : (ok && filled ? ' good' : ''));
    const pwHints = pwv.length === 0 ? 'Use at least 8 characters, with letters and numbers.' : (pwv.length < 8 ? ' · Use at least 8 characters' : (!(/[A-Z]/.test(pwv) && /[a-z]/.test(pwv)) ? ' · Mix capital and small letters' : (!/[0-9]/.test(pwv) ? ' · Add a number' : (!/[^A-Za-z0-9]/.test(pwv) ? ' · Add a symbol' : ' · Great password'))));
    const pwLabels = ['Too short', 'Weak', 'Okay', 'Strong', 'Very strong'];
    const pwBars = [0, 1, 2, 3].map((k) => ({ style: 'height: 6px; border-radius: 999px; transition: background .3s; background: ' + (k < pwScore ? ['#f0a6d8', '#b9a6f5', '#8fc8f5', '#9ee8cf'][k] : 'rgba(29, 27, 60, 0.1)') }));
    const finishAuth = () => {
      if (isCreate) {
        const counts = Object.assign({}, s.counts);
        if (counts[s.obCountry] === undefined) counts[s.obCountry] = 0;
        const cn = s.codename.trim() || (adj[Math.floor(Math.random() * adj.length)] + ' ' + nouns[Math.floor(Math.random() * nouns.length)]);
        this.setState({ authBurst: false, home: s.obCountry, country: s.obCountry, selected: s.obCountry, counts: counts, codename: cn, doneSet: {}, onboarding: true, step: 2, pw: '', authTried: false });
      } else {
        this.setState({ authBurst: false, loggedIn: true, view: 'home', tab: 'home', pw: '', authTried: false });
      }
      toTop();
    };
    const agos = ['just now', '1 min ago', '2 min ago', '4 min ago', '6 min ago'];
    const feed = [];
    for (let i = 0; i < 3; i++) {
      const idx = (s.feedPos + 5 - i + this.pool.length * 2) % this.pool.length;
      const item = this.pool[idx];
      feed.push({ who: item.who, text: item.text, place: item.country, ago: agos[i], dot: this.dots[(idx) % this.dots.length] });
    }
    return Object.assign(tabVals, navVals, {
      featured: featured,
      storyDots: storyDots,
      storyFadeStyle: 'transition: opacity .35s ease, transform .35s ease; ' + (s.storyFade ? 'opacity: 0; transform: translateY(6px);' : 'opacity: 1; transform: none;'),
      totalStr: (s.base + sum).toLocaleString('en-US'),
      globePlaces: names.map((n) => ({ name: n, lat: geo[n].lat, lon: geo[n].lon, color: geo[n].color, here: n === home, sel: n === sel, count: s.counts[n].toLocaleString('en-US') })),
      pickCountry: (n) => this.setState({ selected: n }),
      flashCountry: this.pool[(s.feedPos + 5) % this.pool.length].country,
      tick: s.tick,
      litCount: names.length,
      sel: selInfo,
      feed: feed,
      noSharePhoto: !(sh && sh.photo),
      hasSharePhoto: !!(sh && sh.photo),
      sharePhoto: sh && sh.photo ? sh.photo : '',
      setSharePhoto: (e) => pickPhoto(e, (url) => this.setState({ share: Object.assign({}, this.state.share, { photo: url }) })),
      removeSharePhoto: () => this.setState({ share: Object.assign({}, s.share, { photo: null }) }),
      sightOpen: !!sg,
      sightEditing: !!sg && !sg.sent,
      sightSent: !!sg && sg.sent,
      noSightPhoto: !(sg && sg.photo),
      hasSightPhoto: !!(sg && sg.photo),
      sightPhoto: sg && sg.photo ? sg.photo : '',
      sightText: sg ? sg.text : '',
      sightError: !!(sg && sg.err),
      openSight: () => this.setState({ sight: { photo: null, text: '', sent: false, err: false } }),
      closeSight: () => this.setState({ sight: null }),
      setSightPhoto: (e) => pickPhoto(e, (url) => this.setState({ sight: Object.assign({}, this.state.sight, { photo: url, err: false }) })),
      removeSightPhoto: () => this.setState({ sight: Object.assign({}, s.sight, { photo: null }) }),
      setSightText: (e) => this.setState({ sight: Object.assign({}, s.sight, { text: e.target.value.slice(0, 140) }) }),
      sendSight: () => { if (!sg) return; if (!sg.photo) { this.setState({ sight: Object.assign({}, sg, { err: true }) }); return; } this.setState({ sights: [{ photo: sg.photo, text: sg.text.trim() }].concat(s.sights), sight: Object.assign({}, sg, { sent: true }) }); },
      mySights: s.sights.map((x) => ({ photo: x.photo, text: x.text || 'A peaceful sight', alt: x.text ? 'Your photo: ' + x.text : 'Your shared photo', by: (s.codename.trim() || nameFrom(s.email)) + ' · ' + s.home })),
      noSights: s.sights.length === 0,
      feelings: feelings,
      joinedCount: s.joined,
      joinedText: s.joined === 0 ? 'No one yet. Invite someone to start your chain.' : (s.joined === 1 ? '1 person joined because of you.' : s.joined + ' people joined because of you.'),
      joinedDots: joinedDots,
      inviteOpen: s.inviteOpen,
      inviteExpanded: s.inviteOpen ? 'true' : 'false',
      toggleInvite: () => this.setState({ inviteOpen: !s.inviteOpen, copied: false }),
      inviteLink: inviteLink,
      copyLabel: s.copied ? 'Copied' : 'Copy',
      copyInvite: () => { try { if (navigator.clipboard) navigator.clipboard.writeText('https://' + inviteLink); } catch (e) {} this.setState({ copied: true }); },
      reportOpen: !!rp,
      reportEditing: !!rp && !rp.sent,
      reportSent: !!rp && rp.sent,
      reportWhat: rp ? rp.what : '',
      reportReasons: reportReasons,
      reportError: !!(rp && rp.err),
      sendReport: () => { if (!rp) return; if (rp.reason < 0) { this.setState({ report: Object.assign({}, rp, { err: true }) }); return; } const r = Object.assign({}, s.reported); r[rp.key] = true; this.setState({ reported: r, report: Object.assign({}, rp, { sent: true }) }); },
      closeReport: () => this.setState({ report: null }),
      showGuide: s.view === 'guidelines',
      showAbout: s.view === 'about',
      openGuidelines: () => { this.setState({ view: 'guidelines', menuOpen: false }); toTop(); },
      openAbout: () => { this.setState({ view: 'about', menuOpen: false }); toTop(); },
      openPrivacy: () => { this.setState({ view: 'about', menuOpen: false }); scrollToId('privacy'); },
      forgotSent: s.forgotSent,
      forgotPw: () => this.setState({ forgotSent: true }),
      authIsLogin: !isCreate,
      authIsCreate: isCreate,
      authEyebrow: isCreate ? 'New member' : 'Members',
      authHeadline: isCreate ? 'Start your ripple.' : 'Welcome back to the ripple.',
      authSub: isCreate ? 'Pick a codename, choose your country, and your first act will light it up.' : 'Log in to see your week, your country and everything you’ve shared.',
      authCta: isCreate ? 'Create account' : 'Log in',
      authSwitchText: isCreate ? 'Already have an account?' : 'New to POP?',
      authSwitchCta: isCreate ? 'Log in' : 'Create an account',
      authSwitch: () => this.setState({ authTab: isCreate ? 'login' : 'create', authTried: false, socialNote: '' }),
      tabLogin: () => this.setState({ authTab: 'login', authTried: false, socialNote: '' }),
      tabCreate: () => this.setState({ authTab: 'create', authTried: false, socialNote: '' }),
      selLogin: isCreate ? 'false' : 'true',
      selCreate: isCreate ? 'true' : 'false',
      authTabId: isCreate ? 'tab-create' : 'tab-login',
      tabPill: 'position: absolute; top: 5px; bottom: 5px; width: calc(50% - 5px); left: ' + (isCreate ? '50%' : '5px') + '; border-radius: 999px; background: #ffffff; box-shadow: 0 6px 16px -8px rgba(29, 27, 60, 0.45); transition: left .35s cubic-bezier(.2, .8, .2, 1)',
      tabLoginStyle: 'position: relative; font: inherit; min-height: 46px; border: 0; border-radius: 999px; background: transparent; cursor: pointer; font-size: 15px; font-weight: 600; color: ' + (isCreate ? '#3d3a63' : '#1d1b3c'),
      tabCreateStyle: 'position: relative; font: inherit; min-height: 46px; border: 0; border-radius: 999px; background: transparent; cursor: pointer; font-size: 15px; font-weight: 600; color: ' + (isCreate ? '#1d1b3c' : '#3d3a63'),
      badgeInitial: (s.codename.trim() || '?').charAt(0).toUpperCase(),
      badgeName: s.codename.trim() || 'Your codename',
      badgeCountry: s.obCountry || 'Your country',
      diceStyle: 'transition: transform .6s cubic-bezier(.2, .8, .2, 1); transform: rotate(' + (s.diceSpins * 360) + 'deg)',
      countryFieldClass: fieldCls(countryOk, countryOk) + ' floated',
      countryGood: countryOk,
      countryBad: s.authTried && !countryOk,
      countryInvalid: s.authTried && !countryOk ? 'true' : 'false',
      emailFieldClass: fieldCls(emailOk, emailOk),
      emailGood: emailOk,
      emailBad: s.authTried && !emailOk,
      emailInvalid: s.authTried && !emailOk ? 'true' : 'false',
      pwFieldClass: fieldCls(pwOk, false),
      pw: s.pw,
      setPw: (e) => this.setState({ pw: e.target.value }),
      pwType: s.showPw ? 'text' : 'password',
      pwAuto: isCreate ? 'new-password' : 'current-password',
      slashOp: s.showPw ? '1' : '0',
      pwShownStr: s.showPw ? 'true' : 'false',
      pwToggleLabel: s.showPw ? 'Hide password' : 'Show password',
      togglePw: () => this.setState({ showPw: !s.showPw }),
      pwBars: pwBars,
      pwLabel: pwv.length === 0 ? '' : pwLabels[pwScore],
      pwHint: pwHints,
      pwBad: s.authTried && !pwOk,
      pwInvalid: s.authTried && !pwOk ? 'true' : 'false',
      pwError: isCreate ? 'Use at least 8 characters with a mix of letters and numbers.' : 'Enter your password.',
      hasSocialNote: !!s.socialNote,
      socialNote: s.socialNote,
      socialGoogle: () => this.setState({ socialNote: 'Google sign-in is coming soon.' /* TODO: connect Google sign-in */ }),
      socialApple: () => this.setState({ socialNote: 'Sign in with Apple is coming soon.' /* TODO: connect Sign in with Apple */ }),
      authBurst: s.authBurst,
      burstText: isCreate ? 'Welcome to POP!' : 'Welcome back!',
      authSubmit: () => {
        const ok = emailOk && pwOk && (!isCreate || countryOk);
        if (!ok) { this.setState({ authTried: true }); return; }
        this.setState({ authBurst: true });
        setTimeout(finishAuth, 1100);
      },
      showShareHome: !!sh && sh.from === 'home',
      showShareWeek: !!sh && sh.from === 'week',
      showShareOb: !!sh && sh.from === 'ob',
      shareOpen: !!sh && !sh.sent,
      shareSent: !!sh && sh.sent,
      shareTitle: shareMission ? shareMission.title : '',
      shareText: sh ? sh.text : '',
      shareCount: sh ? sh.text.length : 0,
      setShareText: (e) => this.setState({ share: Object.assign({}, s.share, { text: e.target.value.slice(0, 280) }) }),
      sendShare: () => { if (!sh) return; if (!sh.text.trim() && !sh.photo && !sh.feeling) { this.setState({ share: null }); return; } this.setState({ myStories: [{ idx: sh.idx, text: sh.text.trim(), photo: sh.photo || null, feeling: sh.feeling || null, status: 'In review' }].concat(s.myStories), share: Object.assign({}, sh, { sent: true }) }); },
      skipShare: () => this.setState({ share: null }),
      noStories: s.myStories.length === 0,
      myStoryList: s.myStories.map((m) => ({ title: this.missions[m.idx].title, text: m.text, status: m.status, photo: m.photo || '', hasPhoto: !!m.photo, hasText: !!m.text, feeling: m.feeling || '', hasFeeling: !!m.feeling })),
      worldColStyle: s.loggedIn ? 'flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 20px' : 'flex: 1 1 100%; min-width: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; align-items: start',
      selHint: s.loggedIn ? 'Tap a glowing light on the globe, or drag to spin it.' : 'Tap a glowing light on the globe above to explore.',
      reminderOn: s.reminder,
      remChecked: s.reminder ? 'true' : 'false',
      toggleReminder: () => this.setState({ reminder: !s.reminder }),
      reminderDay: s.reminderDay,
      setReminderDay: (e) => this.setState({ reminderDay: e.target.value }),
      dayOptions: days.map((d) => ({ v: d })),
      reminderPreview: left === 0 ? 'Your week is complete. Rest, or add one more if you feel like it.' : 'You have ' + left + (left === 1 ? ' mission' : ' missions') + ' left this week. No pressure.',
      remTrackStyle: 'flex: none; position: relative; width: 60px; height: 34px; border-radius: 999px; border: 0; padding: 0; cursor: pointer; ' + (s.reminder ? 'background: linear-gradient(90deg, #b9a6f5, #8fc8f5, #9ee8cf);' : 'background: rgba(29, 27, 60, 0.2);'),
      remKnobStyle: 'position: absolute; top: 4px; left: ' + (s.reminder ? '30px' : '4px') + '; width: 26px; height: 26px; border-radius: 50%; background: #ffffff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: left .2s ease',
      showProfile: s.loggedIn && s.view === 'profile',
      notProfile: !((s.loggedIn && s.view === 'profile') || s.view === 'guidelines' || s.view === 'about'),
      navClass: 'navlinks' + (s.menuOpen ? ' open' : ''),
      menuExpanded: s.menuOpen ? 'true' : 'false',
      toggleMenu: () => this.setState({ menuOpen: !s.menuOpen }),
      closeMenu: () => this.setState({ menuOpen: false }),
      goHome: (e) => { if (e && e.preventDefault && s.loggedIn) e.preventDefault(); this.setState({ view: 'home', menuOpen: false, tab: 'home' }); toTop(); },
      goWorld: () => go('world'),
      goMissions: () => go('missions'),
      goStories: () => go('stories'),
      stories: stories,
      storyPrev: () => scrollStories(-1),
      storyNext: () => scrollStories(1),
      openProfile: () => { this.setState({ view: 'profile', menuOpen: false, tab: 'profile' }); toTop(); },
      setHome: (e) => { const v = e.target.value; const counts = Object.assign({}, s.counts); if (counts[v] === undefined) counts[v] = 0; this.setState({ home: v, selected: v, counts: counts }); },
      greeting: greeting,
      memberSince: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      myActs: s.myActs.toLocaleString('en-US'),
      doneCount: doneCount,
      topValue: topTags.length ? topTags[0] : 'Not yet',
      emailShown: s.email || 'Not added',
      hasNext: nextI !== undefined,
      weekComplete: nextI === undefined,
      ringDash: (ringC * ringFrac).toFixed(1) + ' ' + ringC.toFixed(1),
      ringLabel: doneCount + ' of ' + s.pace + ' missions done this week',
      onboarding: s.onboarding,
      notOnboarding: !s.onboarding,
      step: s.step,
      step2: s.step === 2, step3: s.step === 3, step4: s.step === 4,
      stepBars: stepBars,
      backLabel: s.step <= 2 ? 'Back to home' : 'Back',
      obBack: () => { if (s.step <= 2) { this.setState({ onboarding: false }); return; } this.setState({ step: s.step - 1 }); toTop(); },
      obCountry: s.obCountry,
      setObCountry: (e) => this.setState({ obCountry: e.target.value, obError: false }),
      countryOptions: countryOptions,
      home: home,
      homeCountStr: (s.counts[home] || 0).toLocaleString('en-US'),
      pace: s.pace,
      first: first,
      obHint: s.obFlipped ? 'Whenever you’re ready. Today, tomorrow, or later this week.' : 'Tap the card to reveal it.',
      obNext: () => { this.setState({ step: s.step + 1, obFlipped: false }); toTop(); },
      obFlip: () => this.setState({ obFlipped: !s.obFlipped }),
      obDone: () => {
        const counts = Object.assign({}, s.counts);
        counts[s.home] = (counts[s.home] || 0) + 1;
        const d = Object.assign({}, s.doneSet); d[firstI] = true;
        this.setState({ counts: counts, doneSet: d, step: 4, obFlipped: true, myActs: s.myActs + 1, share: { idx: firstI, from: 'ob', text: '', sent: false, photo: null } }); toTop();
      },
      obLater: () => finish('missions'),
      obToMap: () => finish('world'),
      obToMissions: () => finish('missions'),
      startSignup: startSignup,
      cur: curInfo,
      paces: paces,
      week: weekCards,
      emptySlots: emptySlots,
      progressBars: progressBars,
      progressText: progressText,
      filters: filters,
      library: library,
      filterNote: filterNote,
      canShowMore: matched.length > 6,
      moreLabel: s.showAll ? 'Show fewer' : 'Show all ' + matched.length + ' missions',
      toggleAll: () => self.setState({ showAll: !s.showAll }),
      done: s.done,
      country: s.country,
      loggedIn: s.loggedIn,
      loggedOut: !s.loggedIn,
      email: s.email,
      userName: s.codename.trim() || nameFrom(s.email),
      initial: (s.codename.trim() || nameFrom(s.email)).charAt(0).toUpperCase(),
      codename: s.codename,
      setCodename: (e) => this.setState({ codename: e.target.value }),
      surprise: () => this.setState({ diceSpins: s.diceSpins + 1, codename: adj[Math.floor(Math.random() * adj.length)] + ' ' + nouns[Math.floor(Math.random() * nouns.length)] }),
      shuffleDeck: () => { if (s.releasing) return; this.setState({ releasing: true, flipped: {} }); setTimeout(() => { this.setState({ releasing: false, deckOffset: this.state.deckOffset + 1, flipped: {} }); }, 700); },
      letters: letters,
      allOpened: openN === 4,
      openedText: openN + ' / 4 letters opened',
      mapFade: 'transition: opacity .45s ease .25s, filter .45s ease .25s; ' + (s.releasing ? 'opacity: 0; filter: blur(6px);' : 'opacity: 1; filter: none;'),
      goLogin: () => goLogin('login'),
      setEmail: (e) => this.setState({ email: e.target.value }),
      logIn: (e) => { if (e && e.preventDefault) e.preventDefault(); this.setState({ loggedIn: true, view: 'home' }); toTop(); },
      logOut: () => { this.setState({ loggedIn: false, view: 'home', menuOpen: false, missionShown: false, done: false }); toTop(); },
      showMission: () => { if (!s.loggedIn) { goLogin(); return; }  if (s.done && nextI === undefined && typeof document !== 'undefined') { const el = document.getElementById('missions'); if (el) el.scrollIntoView({ behavior: 'smooth' }); } this.setState({ missionShown: true, done: false }); },
      nextMission: () => { if (nextI === undefined) return; const w = s.week.slice(); const r = firstUnused(w); w[w.indexOf(nextI)] = r; this.setState({ week: w, swapCursor: s.swapCursor + 1, done: false }); },
      markDone: () => {
        const counts = Object.assign({}, s.counts);
        counts[s.home] = (counts[s.home] || 0) + 1;
        const d = Object.assign({}, s.doneSet);
        if (nextI !== undefined) d[nextI] = true;
        this.setState({ done: true, counts: counts, doneSet: d, myActs: s.myActs + (nextI !== undefined ? 1 : 0), share: nextI !== undefined ? { idx: nextI, from: 'home', text: '', sent: false, photo: null } : s.share });
      },
      setCountry: (e) => this.setState({ country: e.target.value }),
      start: (e) => { if (e && e.preventDefault) e.preventDefault(); if (!s.loggedIn) { startSignup(); return; } this.setState({ missionShown: true }); if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
  }
}


/* ---------------------------------------------------------------------
   3. GLOBE
   The spinning hologram globe. It redraws about 20 times a second and
   pauses when it is off-screen.
   --------------------------------------------------------------------- */

class Globe extends Component {
  constructor(props) {
    super(props);
    this.state = { rot: -60, frame: 0 };
    const D = LAND_DOTS;
    this.pts = [];
    for (let i = 0; i < D.length; i += 2) {
      const la = D[i + 1] * Math.PI / 180;
      this.pts.push({ l: D[i] * Math.PI / 180, sp: Math.sin(la), cp: Math.cos(la) });
    }
    const t = 16 * Math.PI / 180;
    this.sT = Math.sin(t); this.cT = Math.cos(t);
    this.flashes = [];
    this.gid = 'globe-' + Math.random().toString(36).slice(2, 8);
    this.ticks = 0;
    this.visible = true;
    this.target = null;
    this.drag = null;
    this.pal = ['#f0a6d8', '#b9a6f5', '#8fc8f5', '#9ee8cf', '#f3e9a0'];
    this.defaultPlaces = [
      { name: 'Brazil', lat: -10, lon: -52, color: '#9ee8cf' }, { name: 'Colombia', lat: 4, lon: -73, color: '#f0a6d8', here: true },
      { name: 'Germany', lat: 51, lon: 10, color: '#b9a6f5' }, { name: 'India', lat: 21, lon: 78, color: '#f3e9a0' },
      { name: 'Japan', lat: 36, lon: 138, color: '#8fc8f5' }, { name: 'Kenya', lat: 0, lon: 38, color: '#f0a6d8' },
      { name: 'Lebanon', lat: 34, lon: 36, color: '#9ee8cf' }, { name: 'United States', lat: 39, lon: -98, color: '#8fc8f5' }
    ];
  }
  places() { return this.props.places || this.defaultPlaces; }
  componentDidMount() {
    this.reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.timer = setInterval(() => this.step(), 50);
  }
  componentWillUnmount() { clearInterval(this.timer); }
  componentDidUpdate(prev) {
    if (prev.focus !== this.props.focus && this.props.focus) {
      const f = this.places().filter((p) => p.name === this.props.focus)[0];
      if (f) this.target = f.lon;
    }
    if (prev.flashTick !== this.props.flashTick && this.props.flashCountry) {
      const f = this.places().filter((p) => p.name === this.props.flashCountry)[0];
      if (f) this.flashes.push({ lon: f.lon + (Math.random() * 6 - 3), lat: f.lat + (Math.random() * 6 - 3), t: Date.now(), color: f.color, big: true });
    }
  }
  step() {
    this.ticks++;
    if (this.ticks % 10 === 0 && typeof document !== 'undefined') {
      const el = document.getElementById(this.gid);
      if (el) { const r = el.getBoundingClientRect(); const h = window.innerHeight || 800; this.visible = r.bottom > -50 && r.top < h + 50 && document.visibilityState !== 'hidden'; }
    }
    if (!this.visible && !this.drag) return;
    let rot = this.state.rot;
    if (this.drag) {
      // rotation handled in move
    } else if (this.target !== null) {
      let d = ((this.target - rot + 540) % 360) - 180;
      rot += d * 0.1;
      if (Math.abs(d) < 0.4) { this.target = null; this.holdUntil = Date.now() + 6000; }
    } else if (!this.reduce && Date.now() > (this.holdUntil || 0)) {
      rot += 0.2;
    }
    if (Math.random() < 0.07) {
      const p = this.pts[Math.floor(Math.random() * this.pts.length)];
      this.flashes.push({ lon: p.l * 180 / Math.PI, lat: Math.asin(p.sp) * 180 / Math.PI, t: Date.now(), color: this.pal[Math.floor(Math.random() * 5)] });
    }
    const now = Date.now();
    this.flashes = this.flashes.filter((f) => now - f.t < 1800);
    this.setState({ rot: ((rot + 540) % 360) - 180, frame: this.state.frame + 1 });
  }
  proj(lonDeg, latDeg, l0) {
    const la = latDeg * Math.PI / 180, dl = lonDeg * Math.PI / 180 - l0;
    const sp = Math.sin(la), cp = Math.cos(la), cd = Math.cos(dl);
    return { x: 300 + 250 * cp * Math.sin(dl), y: 300 - 250 * (this.cT * sp - this.sT * cp * cd), z: this.sT * sp + this.cT * cp * cd };
  }
  renderVals() {
    const l0 = this.state.rot * Math.PI / 180;
    const sT = this.sT, cT = this.cT;
    let front = '', rim = '', back = '';
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      const dl = p.l - l0, cd = Math.cos(dl);
      const z = sT * p.sp + cT * p.cp * cd;
      const x = (300 + 250 * p.cp * Math.sin(dl)).toFixed(1);
      const y = (300 - 250 * (cT * p.sp - sT * p.cp * cd)).toFixed(1);
      const seg = 'M' + x + ' ' + y + 'h0';
      if (z > 0.28) front += seg; else if (z > 0) rim += seg; else back += seg;
    }
    let grid = '';
    for (let m = -180; m < 180; m += 30) {
      let pen = false;
      for (let la = -90; la <= 90; la += 5) {
        const q = this.proj(m, la, l0);
        if (q.z > 0) { grid += (pen ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); pen = true; } else pen = false;
      }
    }
    for (let la = -60; la <= 60; la += 30) {
      let pen = false;
      for (let lo = -180; lo <= 180; lo += 5) {
        const q = this.proj(lo, la, l0);
        if (q.z > 0) { grid += (pen ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); pen = true; } else pen = false;
      }
    }
    const now = Date.now();
    const flashes = [];
    this.flashes.forEach((f) => {
      const q = this.proj(f.lon, f.lat, l0);
      if (q.z <= 0.05) return;
      const a = (now - f.t) / 1800;
      flashes.push({ x: q.x.toFixed(1), y: q.y.toFixed(1), r: ((f.big ? 6 : 3) + a * (f.big ? 34 : 14)).toFixed(1), o: (1 - a).toFixed(2), color: f.color });
    });
    const fr = this.state.frame;
    const pins = [];
    this.places().forEach((p, i) => {
      const q = this.proj(p.lon, p.lat, l0);
      if (q.z <= 0.06) return;
      const ph = ((fr * 0.025) + i * 0.37) % 1;
      const showLabel = p.sel || p.here;
      const size = p.sel ? 18 : 14;
      pins.push({
        aria: p.name + (p.count ? ': ' + p.count + ' acts of peace' : ''),
        label: p.here ? p.name + ' · you' : p.name,
        style: 'position: absolute; left: ' + (q.x / 6).toFixed(2) + '%; top: ' + (q.y / 6).toFixed(2) + '%; width: 44px; height: 44px; transform: translate(-50%, -50%); padding: 0; border: 0; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: ' + Math.min(1, q.z * 3).toFixed(2) + '; z-index: ' + (p.sel ? 3 : 2),
        ringStyle: 'position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; border: 2px solid ' + p.color + '; transform: scale(' + (0.3 + ph * 0.9).toFixed(2) + '); opacity: ' + (1 - ph).toFixed(2) + '; pointer-events: none',
        dotStyle: 'position: relative; width: ' + size + 'px; height: ' + size + 'px; border-radius: 50%; background: ' + p.color + '; box-shadow: 0 0 0 3px #1f1c3b, 0 0 14px 4px ' + p.color + (p.sel ? ', 0 0 0 6px rgba(255, 255, 255, 0.85)' : ''),
        labelStyle: 'position: absolute; top: 40px; left: 50%; transform: translateX(-50%); white-space: nowrap; font: 600 13px Inter, system-ui, sans-serif; padding: 5px 11px; border-radius: 999px; pointer-events: none; display: ' + (showLabel ? 'block' : 'none') + '; ' + (p.sel ? 'background: #ffffff; color: #1d1b3c;' : 'background: rgba(31, 28, 59, 0.88); color: #f4f2ff; border: 1px solid rgba(255, 255, 255, 0.25);'),
        pick: () => { this.target = p.lon; if (this.props.onPick) this.props.onPick(p.name); }
      });
    });
    return {
      frontD: front || 'M0 0', rimD: rim || 'M0 0', backD: back || 'M0 0', gridD: grid || 'M0 0',
      gid: this.gid,
      flashes: flashes, pins: pins,
      dashA: (-fr * 0.6).toFixed(1),
      cursor: this.drag ? 'grabbing' : 'grab',
      down: (e) => { this.drag = { x: e.clientX, rot: this.state.rot, moved: false }; this.target = null; this.holdUntil = 0; },
      move: (e) => {
        if (!this.drag) return;
        const dx = e.clientX - this.drag.x;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        if (this.drag.moved) this.setState({ rot: this.drag.rot - dx * 0.4 });
      },
      up: () => { this.drag = null; }
    };
  }
}


/* ---------------------------------------------------------------------
   4. START THE APP
   --------------------------------------------------------------------- */

const COMPONENTS = { Globe: Globe };

// Land positions for the globe, as [longitude, latitude] pairs on a 2-degree grid.
const LAND_DOTS = [-119,75,-117,75,-115,75,-113,75,-111,75,-109,75,-107,75,-105,75,-103,75,-101,75,-99,75,-97,75,-95,75,-93,75,-91,75,-89,75,-87,75,-85,75,-83,75,-81,75,-79,75,-71,75,-69,75,-67,75,-65,75,-63,75,-61,75,-59,75,-57,75,-55,75,-53,75,-51,75,-49,75,-47,75,-45,75,-43,75,-41,75,-39,75,-37,75,-35,75,-33,75,-31,75,-29,75,-27,75,-25,75,-23,75,-21,75,55,75,57,75,59,75,81,75,83,75,85,75,87,75,89,75,91,75,93,75,95,75,97,75,99,75,101,75,103,75,105,75,107,75,109,75,111,75,113,75,115,75,131,75,133,75,135,75,137,75,139,75,141,75,143,75,145,75,147,75,149,75,-119,73,-117,73,-115,73,-113,73,-111,73,-109,73,-107,73,-105,73,-103,73,-101,73,-99,73,-97,73,-95,73,-93,73,-91,73,-89,73,-87,73,-85,73,-83,73,-81,73,-79,73,-71,73,-69,73,-67,73,-65,73,-63,73,-61,73,-59,73,-57,73,-55,73,-53,73,-51,73,-49,73,-47,73,-45,73,-43,73,-41,73,-39,73,-37,73,-35,73,-33,73,-31,73,-29,73,-27,73,-25,73,-23,73,-21,73,55,73,57,73,59,73,81,73,83,73,85,73,87,73,89,73,91,73,93,73,95,73,97,73,99,73,101,73,103,73,105,73,107,73,109,73,111,73,113,73,115,73,131,73,133,73,135,73,137,73,139,73,141,73,143,73,145,73,147,73,149,73,-161,71,-159,71,-157,71,-155,71,-153,71,-151,71,-149,71,-147,71,-145,71,-143,71,-137,71,-135,71,-133,71,-131,71,-129,71,-127,71,-125,71,-123,71,-121,71,-119,71,-117,71,-115,71,-113,71,-111,71,-109,71,-107,71,-105,71,-103,71,-101,71,-99,71,-97,71,-95,71,-93,71,-91,71,-89,71,-87,71,-85,71,-79,71,-77,71,-75,71,-73,71,-71,71,-69,71,-67,71,-65,71,-63,71,-55,71,-53,71,-51,71,-49,71,-47,71,-45,71,-43,71,-41,71,-39,71,-37,71,-35,71,-33,71,-31,71,-29,71,-27,71,-25,71,-23,71,19,71,21,71,23,71,25,71,27,71,29,71,67,71,69,71,71,71,73,71,75,71,77,71,79,71,81,71,83,71,85,71,87,71,89,71,91,71,93,71,95,71,97,71,99,71,101,71,103,71,105,71,107,71,109,71,111,71,113,71,115,71,117,71,119,71,121,71,123,71,125,71,127,71,129,71,131,71,133,71,135,71,137,71,139,71,141,71,143,71,145,71,147,71,149,71,151,71,153,71,155,71,157,71,159,71,161,71,163,71,165,71,167,71,169,71,171,71,173,71,175,71,177,71,179,71,-161,69,-159,69,-157,69,-155,69,-153,69,-151,69,-149,69,-147,69,-145,69,-143,69,-137,69,-135,69,-133,69,-131,69,-129,69,-127,69,-125,69,-123,69,-121,69,-119,69,-117,69,-115,69,-113,69,-111,69,-109,69,-107,69,-105,69,-103,69,-101,69,-99,69,-97,69,-95,69,-93,69,-91,69,-89,69,-87,69,-85,69,-79,69,-77,69,-75,69,-73,69,-71,69,-69,69,-67,69,-65,69,-63,69,-55,69,-53,69,-51,69,-49,69,-47,69,-45,69,-43,69,-41,69,-39,69,-37,69,-35,69,-33,69,-31,69,-29,69,-27,69,-25,69,-23,69,19,69,21,69,23,69,25,69,27,69,29,69,67,69,69,69,71,69,73,69,75,69,77,69,79,69,81,69,83,69,85,69,87,69,89,69,91,69,93,69,95,69,97,69,99,69,101,69,103,69,105,69,107,69,109,69,111,69,113,69,115,69,117,69,119,69,121,69,123,69,125,69,127,69,129,69,131,69,133,69,135,69,137,69,139,69,141,69,143,69,145,69,147,69,149,69,151,69,153,69,155,69,157,69,159,69,161,69,163,69,165,69,167,69,169,69,171,69,173,69,175,69,177,69,179,69,-179,67,-177,67,-175,67,-173,67,-171,67,-165,67,-163,67,-161,67,-159,67,-157,67,-155,67,-153,67,-151,67,-149,67,-147,67,-145,67,-143,67,-141,67,-139,67,-137,67,-135,67,-133,67,-131,67,-129,67,-127,67,-125,67,-123,67,-121,67,-119,67,-117,67,-115,67,-113,67,-111,67,-109,67,-107,67,-105,67,-103,67,-101,67,-99,67,-97,67,-95,67,-93,67,-91,67,-89,67,-87,67,-75,67,-73,67,-71,67,-69,67,-67,67,-65,67,-63,67,-51,67,-49,67,-47,67,-45,67,-43,67,-41,67,-39,67,-37,67,-35,67,-23,67,-21,67,-19,67,-17,67,-15,67,13,67,15,67,17,67,19,67,21,67,23,67,25,67,27,67,29,67,31,67,33,67,35,67,37,67,39,67,41,67,43,67,45,67,47,67,49,67,51,67,53,67,55,67,57,67,59,67,61,67,63,67,65,67,67,67,69,67,71,67,73,67,75,67,77,67,79,67,81,67,83,67,85,67,87,67,89,67,91,67,93,67,95,67,97,67,99,67,101,67,103,67,105,67,107,67,109,67,111,67,113,67,115,67,117,67,119,67,121,67,123,67,125,67,127,67,129,67,131,67,133,67,135,67,137,67,139,67,141,67,143,67,145,67,147,67,149,67,151,67,153,67,155,67,157,67,159,67,161,67,163,67,165,67,167,67,169,67,171,67,173,67,175,67,177,67,179,67,-179,65,-177,65,-175,65,-173,65,-171,65,-165,65,-163,65,-161,65,-159,65,-157,65,-155,65,-153,65,-151,65,-149,65,-147,65,-145,65,-143,65,-141,65,-139,65,-137,65,-135,65,-133,65,-131,65,-129,65,-127,65,-125,65,-123,65,-121,65,-119,65,-117,65,-115,65,-113,65,-111,65,-109,65,-107,65,-105,65,-103,65,-101,65,-99,65,-97,65,-95,65,-93,65,-91,65,-89,65,-87,65,-75,65,-73,65,-71,65,-69,65,-67,65,-65,65,-63,65,-51,65,-49,65,-47,65,-45,65,-43,65,-41,65,-39,65,-37,65,-35,65,-23,65,-21,65,-19,65,-17,65,-15,65,13,65,15,65,17,65,19,65,21,65,23,65,25,65,27,65,29,65,31,65,33,65,35,65,37,65,39,65,41,65,43,65,45,65,47,65,49,65,51,65,53,65,55,65,57,65,59,65,61,65,63,65,65,65,67,65,69,65,71,65,73,65,75,65,77,65,79,65,81,65,83,65,85,65,87,65,89,65,91,65,93,65,95,65,97,65,99,65,101,65,103,65,105,65,107,65,109,65,111,65,113,65,115,65,117,65,119,65,121,65,123,65,125,65,127,65,129,65,131,65,133,65,135,65,137,65,139,65,141,65,143,65,145,65,147,65,149,65,151,65,153,65,155,65,157,65,159,65,161,65,163,65,165,65,167,65,169,65,171,65,173,65,175,65,177,65,179,65,-179,63,-177,63,-175,63,-165,63,-163,63,-161,63,-159,63,-157,63,-155,63,-153,63,-151,63,-149,63,-147,63,-145,63,-143,63,-141,63,-139,63,-137,63,-135,63,-133,63,-131,63,-129,63,-127,63,-125,63,-123,63,-121,63,-119,63,-117,63,-115,63,-113,63,-111,63,-109,63,-107,63,-105,63,-103,63,-101,63,-99,63,-97,63,-95,63,-77,63,-75,63,-73,63,-71,63,-69,63,-67,63,-65,63,-49,63,-47,63,-45,63,-43,63,5,63,7,63,9,63,11,63,13,63,15,63,17,63,21,63,23,63,25,63,27,63,29,63,31,63,33,63,35,63,37,63,39,63,41,63,43,63,45,63,47,63,49,63,51,63,53,63,55,63,57,63,59,63,61,63,63,63,65,63,67,63,69,63,71,63,73,63,75,63,77,63,79,63,81,63,83,63,85,63,87,63,89,63,91,63,93,63,95,63,97,63,99,63,101,63,103,63,105,63,107,63,109,63,111,63,113,63,115,63,117,63,119,63,121,63,123,63,125,63,127,63,129,63,131,63,133,63,135,63,137,63,139,63,141,63,143,63,145,63,147,63,149,63,151,63,153,63,155,63,157,63,159,63,161,63,163,63,165,63,167,63,169,63,171,63,173,63,175,63,177,63,179,63,-179,61,-177,61,-175,61,-165,61,-163,61,-161,61,-159,61,-157,61,-155,61,-153,61,-151,61,-149,61,-147,61,-145,61,-143,61,-141,61,-139,61,-137,61,-135,61,-133,61,-131,61,-129,61,-127,61,-125,61,-123,61,-121,61,-119,61,-117,61,-115,61,-113,61,-111,61,-109,61,-107,61,-105,61,-103,61,-101,61,-99,61,-97,61,-95,61,-77,61,-75,61,-73,61,-71,61,-69,61,-67,61,-65,61,-49,61,-47,61,-45,61,-43,61,5,61,7,61,9,61,11,61,13,61,15,61,17,61,21,61,23,61,25,61,27,61,29,61,31,61,33,61,35,61,37,61,39,61,41,61,43,61,45,61,47,61,49,61,51,61,53,61,55,61,57,61,59,61,61,61,63,61,65,61,67,61,69,61,71,61,73,61,75,61,77,61,79,61,81,61,83,61,85,61,87,61,89,61,91,61,93,61,95,61,97,61,99,61,101,61,103,61,105,61,107,61,109,61,111,61,113,61,115,61,117,61,119,61,121,61,123,61,125,61,127,61,129,61,131,61,133,61,135,61,137,61,139,61,141,61,143,61,145,61,147,61,149,61,151,61,153,61,155,61,157,61,159,61,161,61,163,61,165,61,167,61,169,61,171,61,173,61,175,61,177,61,179,61,-159,59,-157,59,-155,59,-153,59,-151,59,-149,59,-147,59,-145,59,-143,59,-141,59,-139,59,-137,59,-135,59,-133,59,-131,59,-129,59,-127,59,-125,59,-123,59,-121,59,-119,59,-117,59,-115,59,-113,59,-111,59,-109,59,-107,59,-105,59,-103,59,-101,59,-99,59,-97,59,-95,59,-77,59,-75,59,-73,59,-71,59,-69,59,-67,59,-65,59,-63,59,-5,59,-3,59,7,59,9,59,11,59,13,59,15,59,17,59,23,59,25,59,27,59,29,59,31,59,33,59,35,59,37,59,39,59,41,59,43,59,45,59,47,59,49,59,51,59,53,59,55,59,57,59,59,59,61,59,63,59,65,59,67,59,69,59,71,59,73,59,75,59,77,59,79,59,81,59,83,59,85,59,87,59,89,59,91,59,93,59,95,59,97,59,99,59,101,59,103,59,105,59,107,59,109,59,111,59,113,59,115,59,117,59,119,59,121,59,123,59,125,59,127,59,129,59,131,59,133,59,135,59,137,59,157,59,159,59,161,59,163,59,-159,57,-157,57,-155,57,-153,57,-151,57,-149,57,-147,57,-145,57,-143,57,-141,57,-139,57,-137,57,-135,57,-133,57,-131,57,-129,57,-127,57,-125,57,-123,57,-121,57,-119,57,-117,57,-115,57,-113,57,-111,57,-109,57,-107,57,-105,57,-103,57,-101,57,-99,57,-97,57,-95,57,-77,57,-75,57,-73,57,-71,57,-69,57,-67,57,-65,57,-63,57,-5,57,-3,57,7,57,9,57,11,57,13,57,15,57,17,57,23,57,25,57,27,57,29,57,31,57,33,57,35,57,37,57,39,57,41,57,43,57,45,57,47,57,49,57,51,57,53,57,55,57,57,57,59,57,61,57,63,57,65,57,67,57,69,57,71,57,73,57,75,57,77,57,79,57,81,57,83,57,85,57,87,57,89,57,91,57,93,57,95,57,97,57,99,57,101,57,103,57,105,57,107,57,109,57,111,57,113,57,115,57,117,57,119,57,121,57,123,57,125,57,127,57,129,57,131,57,133,57,135,57,137,57,157,57,159,57,161,57,163,57,-131,55,-129,55,-127,55,-125,55,-123,55,-121,55,-119,55,-117,55,-115,55,-113,55,-111,55,-109,55,-107,55,-105,55,-103,55,-101,55,-99,55,-97,55,-95,55,-93,55,-91,55,-89,55,-87,55,-85,55,-83,55,-81,55,-77,55,-75,55,-73,55,-71,55,-69,55,-67,55,-65,55,-63,55,-61,55,-59,55,-57,55,-9,55,-7,55,-5,55,-3,55,-1,55,7,55,9,55,11,55,13,55,15,55,17,55,19,55,21,55,23,55,25,55,27,55,29,55,31,55,33,55,35,55,37,55,39,55,41,55,43,55,45,55,47,55,49,55,51,55,53,55,55,55,57,55,59,55,61,55,63,55,65,55,67,55,69,55,71,55,73,55,75,55,77,55,79,55,81,55,83,55,85,55,87,55,89,55,91,55,93,55,95,55,97,55,99,55,101,55,103,55,105,55,107,55,109,55,111,55,113,55,115,55,117,55,119,55,121,55,123,55,125,55,127,55,129,55,131,55,133,55,135,55,137,55,139,55,157,55,159,55,161,55,-131,53,-129,53,-127,53,-125,53,-123,53,-121,53,-119,53,-117,53,-115,53,-113,53,-111,53,-109,53,-107,53,-105,53,-103,53,-101,53,-99,53,-97,53,-95,53,-93,53,-91,53,-89,53,-87,53,-85,53,-83,53,-81,53,-77,53,-75,53,-73,53,-71,53,-69,53,-67,53,-65,53,-63,53,-61,53,-59,53,-57,53,-9,53,-7,53,-5,53,-3,53,-1,53,7,53,9,53,11,53,13,53,15,53,17,53,19,53,21,53,23,53,25,53,27,53,29,53,31,53,33,53,35,53,37,53,39,53,41,53,43,53,45,53,47,53,49,53,51,53,53,53,55,53,57,53,59,53,61,53,63,53,65,53,67,53,69,53,71,53,73,53,75,53,77,53,79,53,81,53,83,53,85,53,87,53,89,53,91,53,93,53,95,53,97,53,99,53,101,53,103,53,105,53,107,53,109,53,111,53,113,53,115,53,117,53,119,53,121,53,123,53,125,53,127,53,129,53,131,53,133,53,135,53,137,53,139,53,157,53,159,53,161,53,-127,51,-125,51,-123,51,-121,51,-119,51,-117,51,-115,51,-113,51,-111,51,-109,51,-107,51,-105,51,-103,51,-101,51,-99,51,-97,51,-95,51,-93,51,-91,51,-89,51,-87,51,-85,51,-83,51,-81,51,-79,51,-77,51,-75,51,-73,51,-71,51,-69,51,-67,51,-65,51,-63,51,-61,51,-59,51,-57,51,-5,51,-3,51,-1,51,1,51,3,51,5,51,7,51,9,51,11,51,13,51,15,51,17,51,19,51,21,51,23,51,25,51,27,51,29,51,31,51,33,51,35,51,37,51,39,51,41,51,43,51,45,51,47,51,49,51,51,51,53,51,55,51,57,51,59,51,61,51,63,51,65,51,67,51,69,51,71,51,73,51,75,51,77,51,79,51,81,51,83,51,85,51,87,51,89,51,91,51,93,51,95,51,97,51,99,51,101,51,103,51,105,51,107,51,109,51,111,51,113,51,115,51,117,51,119,51,121,51,123,51,125,51,127,51,129,51,131,51,133,51,135,51,137,51,139,51,141,51,143,51,-127,49,-125,49,-123,49,-121,49,-119,49,-117,49,-115,49,-113,49,-111,49,-109,49,-107,49,-105,49,-103,49,-101,49,-99,49,-97,49,-95,49,-93,49,-91,49,-89,49,-87,49,-85,49,-83,49,-81,49,-79,49,-77,49,-75,49,-73,49,-71,49,-69,49,-67,49,-65,49,-63,49,-61,49,-59,49,-57,49,-5,49,-3,49,-1,49,1,49,3,49,5,49,7,49,9,49,11,49,13,49,15,49,17,49,19,49,21,49,23,49,25,49,27,49,29,49,31,49,33,49,35,49,37,49,39,49,41,49,43,49,45,49,47,49,49,49,51,49,53,49,55,49,57,49,59,49,61,49,63,49,65,49,67,49,69,49,71,49,73,49,75,49,77,49,79,49,81,49,83,49,85,49,87,49,89,49,91,49,93,49,95,49,97,49,99,49,101,49,103,49,105,49,107,49,109,49,111,49,113,49,115,49,117,49,119,49,121,49,123,49,125,49,127,49,129,49,131,49,133,49,135,49,137,49,139,49,141,49,143,49,-123,47,-121,47,-119,47,-117,47,-115,47,-113,47,-111,47,-109,47,-107,47,-105,47,-103,47,-101,47,-99,47,-97,47,-95,47,-93,47,-91,47,-89,47,-87,47,-85,47,-83,47,-81,47,-79,47,-77,47,-75,47,-73,47,-71,47,-69,47,-67,47,-65,47,-63,47,-61,47,-1,47,1,47,3,47,5,47,7,47,9,47,11,47,13,47,15,47,17,47,19,47,21,47,23,47,25,47,27,47,29,47,41,47,43,47,45,47,47,47,53,47,55,47,57,47,59,47,61,47,63,47,65,47,67,47,69,47,71,47,73,47,75,47,77,47,79,47,81,47,83,47,85,47,87,47,89,47,91,47,93,47,95,47,97,47,99,47,101,47,103,47,105,47,107,47,109,47,111,47,113,47,115,47,117,47,119,47,121,47,123,47,125,47,127,47,129,47,131,47,133,47,135,47,137,47,139,47,141,47,143,47,145,47,-123,45,-121,45,-119,45,-117,45,-115,45,-113,45,-111,45,-109,45,-107,45,-105,45,-103,45,-101,45,-99,45,-97,45,-95,45,-93,45,-91,45,-89,45,-87,45,-85,45,-83,45,-81,45,-79,45,-77,45,-75,45,-73,45,-71,45,-69,45,-67,45,-65,45,-63,45,-61,45,-1,45,1,45,3,45,5,45,7,45,9,45,11,45,13,45,15,45,17,45,19,45,21,45,23,45,25,45,27,45,29,45,41,45,43,45,45,45,47,45,53,45,55,45,57,45,59,45,61,45,63,45,65,45,67,45,69,45,71,45,73,45,75,45,77,45,79,45,81,45,83,45,85,45,87,45,89,45,91,45,93,45,95,45,97,45,99,45,101,45,103,45,105,45,107,45,109,45,111,45,113,45,115,45,117,45,119,45,121,45,123,45,125,45,127,45,129,45,131,45,133,45,135,45,137,45,139,45,141,45,143,45,145,45,-123,43,-121,43,-119,43,-117,43,-115,43,-113,43,-111,43,-109,43,-107,43,-105,43,-103,43,-101,43,-99,43,-97,43,-95,43,-93,43,-91,43,-89,43,-87,43,-85,43,-83,43,-81,43,-79,43,-77,43,-75,43,-73,43,-71,43,-9,43,-7,43,-5,43,-3,43,-1,43,1,43,3,43,11,43,13,43,15,43,17,43,19,43,21,43,23,43,25,43,27,43,41,43,43,43,45,43,47,43,49,43,55,43,57,43,59,43,61,43,63,43,65,43,67,43,69,43,71,43,73,43,75,43,77,43,79,43,81,43,83,43,85,43,87,43,89,43,91,43,93,43,95,43,97,43,99,43,101,43,103,43,105,43,107,43,109,43,111,43,113,43,115,43,117,43,119,43,121,43,123,43,125,43,127,43,129,43,141,43,-123,41,-121,41,-119,41,-117,41,-115,41,-113,41,-111,41,-109,41,-107,41,-105,41,-103,41,-101,41,-99,41,-97,41,-95,41,-93,41,-91,41,-89,41,-87,41,-85,41,-83,41,-81,41,-79,41,-77,41,-75,41,-73,41,-71,41,-9,41,-7,41,-5,41,-3,41,-1,41,1,41,3,41,11,41,13,41,15,41,17,41,19,41,21,41,23,41,25,41,27,41,41,41,43,41,45,41,47,41,49,41,55,41,57,41,59,41,61,41,63,41,65,41,67,41,69,41,71,41,73,41,75,41,77,41,79,41,81,41,83,41,85,41,87,41,89,41,91,41,93,41,95,41,97,41,99,41,101,41,103,41,105,41,107,41,109,41,111,41,113,41,115,41,117,41,119,41,121,41,123,41,125,41,127,41,129,41,141,41,-123,39,-121,39,-119,39,-117,39,-115,39,-113,39,-111,39,-109,39,-107,39,-105,39,-103,39,-101,39,-99,39,-97,39,-95,39,-93,39,-91,39,-89,39,-87,39,-85,39,-83,39,-81,39,-79,39,-77,39,-9,39,-7,39,-5,39,-3,39,-1,39,13,39,15,39,21,39,23,39,27,39,29,39,31,39,33,39,35,39,37,39,39,39,41,39,43,39,45,39,47,39,49,39,55,39,57,39,59,39,61,39,63,39,65,39,67,39,69,39,71,39,73,39,75,39,77,39,79,39,81,39,83,39,85,39,87,39,89,39,91,39,93,39,95,39,97,39,99,39,101,39,103,39,105,39,107,39,109,39,111,39,113,39,115,39,117,39,119,39,127,39,129,39,139,39,141,39,-123,37,-121,37,-119,37,-117,37,-115,37,-113,37,-111,37,-109,37,-107,37,-105,37,-103,37,-101,37,-99,37,-97,37,-95,37,-93,37,-91,37,-89,37,-87,37,-85,37,-83,37,-81,37,-79,37,-77,37,-9,37,-7,37,-5,37,-3,37,-1,37,13,37,15,37,21,37,23,37,27,37,29,37,31,37,33,37,35,37,37,37,39,37,41,37,43,37,45,37,47,37,49,37,55,37,57,37,59,37,61,37,63,37,65,37,67,37,69,37,71,37,73,37,75,37,77,37,79,37,81,37,83,37,85,37,87,37,89,37,91,37,93,37,95,37,97,37,99,37,101,37,103,37,105,37,107,37,109,37,111,37,113,37,115,37,117,37,119,37,127,37,129,37,139,37,141,37,-119,35,-117,35,-115,35,-113,35,-111,35,-109,35,-107,35,-105,35,-103,35,-101,35,-99,35,-97,35,-95,35,-93,35,-91,35,-89,35,-87,35,-85,35,-83,35,-81,35,-79,35,-7,35,-5,35,-3,35,-1,35,1,35,3,35,5,35,7,35,9,35,11,35,35,35,37,35,39,35,41,35,43,35,45,35,47,35,49,35,51,35,53,35,55,35,57,35,59,35,61,35,63,35,65,35,67,35,69,35,71,35,73,35,75,35,77,35,79,35,81,35,83,35,85,35,87,35,89,35,91,35,93,35,95,35,97,35,99,35,101,35,103,35,105,35,107,35,109,35,111,35,113,35,115,35,117,35,119,35,131,35,133,35,135,35,137,35,139,35,-119,33,-117,33,-115,33,-113,33,-111,33,-109,33,-107,33,-105,33,-103,33,-101,33,-99,33,-97,33,-95,33,-93,33,-91,33,-89,33,-87,33,-85,33,-83,33,-81,33,-79,33,-7,33,-5,33,-3,33,-1,33,1,33,3,33,5,33,7,33,9,33,11,33,35,33,37,33,39,33,41,33,43,33,45,33,47,33,49,33,51,33,53,33,55,33,57,33,59,33,61,33,63,33,65,33,67,33,69,33,71,33,73,33,75,33,77,33,79,33,81,33,83,33,85,33,87,33,89,33,91,33,93,33,95,33,97,33,99,33,101,33,103,33,105,33,107,33,109,33,111,33,113,33,115,33,117,33,119,33,131,33,133,33,135,33,137,33,139,33,-115,31,-113,31,-111,31,-109,31,-107,31,-105,31,-103,31,-101,31,-99,31,-97,31,-95,31,-93,31,-91,31,-89,31,-87,31,-85,31,-83,31,-9,31,-7,31,-5,31,-3,31,-1,31,1,31,3,31,5,31,7,31,9,31,11,31,13,31,15,31,17,31,19,31,21,31,23,31,25,31,27,31,29,31,31,31,33,31,35,31,37,31,39,31,41,31,43,31,45,31,47,31,51,31,53,31,55,31,57,31,59,31,61,31,63,31,65,31,67,31,69,31,71,31,73,31,75,31,77,31,79,31,81,31,83,31,85,31,87,31,89,31,91,31,93,31,95,31,97,31,99,31,101,31,103,31,105,31,107,31,109,31,111,31,113,31,115,31,117,31,119,31,121,31,-115,29,-113,29,-111,29,-109,29,-107,29,-105,29,-103,29,-101,29,-99,29,-97,29,-95,29,-93,29,-91,29,-89,29,-87,29,-85,29,-83,29,-9,29,-7,29,-5,29,-3,29,-1,29,1,29,3,29,5,29,7,29,9,29,11,29,13,29,15,29,17,29,19,29,21,29,23,29,25,29,27,29,29,29,31,29,33,29,35,29,37,29,39,29,41,29,43,29,45,29,47,29,51,29,53,29,55,29,57,29,59,29,61,29,63,29,65,29,67,29,69,29,71,29,73,29,75,29,77,29,79,29,81,29,83,29,85,29,87,29,89,29,91,29,93,29,95,29,97,29,99,29,101,29,103,29,105,29,107,29,109,29,111,29,113,29,115,29,117,29,119,29,121,29,-111,27,-109,27,-107,27,-105,27,-103,27,-101,27,-99,27,-97,27,-81,27,-13,27,-11,27,-9,27,-7,27,-5,27,-3,27,-1,27,1,27,3,27,5,27,7,27,9,27,11,27,13,27,15,27,17,27,19,27,21,27,23,27,25,27,27,27,29,27,31,27,33,27,35,27,37,27,39,27,41,27,43,27,45,27,47,27,49,27,51,27,53,27,55,27,57,27,59,27,61,27,69,27,71,27,73,27,75,27,77,27,79,27,81,27,83,27,85,27,87,27,89,27,91,27,93,27,95,27,97,27,99,27,101,27,103,27,105,27,107,27,109,27,111,27,113,27,115,27,117,27,119,27,121,27,-111,25,-109,25,-107,25,-105,25,-103,25,-101,25,-99,25,-97,25,-81,25,-13,25,-11,25,-9,25,-7,25,-5,25,-3,25,-1,25,1,25,3,25,5,25,7,25,9,25,11,25,13,25,15,25,17,25,19,25,21,25,23,25,25,25,27,25,29,25,31,25,33,25,35,25,37,25,39,25,41,25,43,25,45,25,47,25,49,25,51,25,53,25,55,25,57,25,59,25,61,25,69,25,71,25,73,25,75,25,77,25,79,25,81,25,83,25,85,25,87,25,89,25,91,25,93,25,95,25,97,25,99,25,101,25,103,25,105,25,107,25,109,25,111,25,113,25,115,25,117,25,119,25,121,25,-105,23,-103,23,-101,23,-99,23,-97,23,-83,23,-81,23,-79,23,-77,23,-75,23,-15,23,-13,23,-11,23,-9,23,-7,23,-5,23,-3,23,-1,23,1,23,3,23,5,23,7,23,9,23,11,23,13,23,15,23,17,23,19,23,21,23,23,23,25,23,27,23,29,23,31,23,33,23,35,23,37,23,39,23,41,23,43,23,45,23,47,23,49,23,51,23,53,23,55,23,57,23,59,23,69,23,71,23,73,23,75,23,77,23,79,23,81,23,83,23,85,23,87,23,89,23,91,23,93,23,95,23,97,23,99,23,101,23,103,23,105,23,107,23,109,23,111,23,113,23,115,23,117,23,-105,21,-103,21,-101,21,-99,21,-97,21,-83,21,-81,21,-79,21,-77,21,-75,21,-15,21,-13,21,-11,21,-9,21,-7,21,-5,21,-3,21,-1,21,1,21,3,21,5,21,7,21,9,21,11,21,13,21,15,21,17,21,19,21,21,21,23,21,25,21,27,21,29,21,31,21,33,21,35,21,37,21,39,21,41,21,43,21,45,21,47,21,49,21,51,21,53,21,55,21,57,21,59,21,69,21,71,21,73,21,75,21,77,21,79,21,81,21,83,21,85,21,87,21,89,21,91,21,93,21,95,21,97,21,99,21,101,21,103,21,105,21,107,21,109,21,111,21,113,21,115,21,117,21,-103,19,-101,19,-99,19,-97,19,-95,19,-93,19,-91,19,-89,19,-73,19,-71,19,-69,19,-15,19,-13,19,-11,19,-9,19,-7,19,-5,19,-3,19,-1,19,1,19,3,19,5,19,7,19,9,19,11,19,13,19,15,19,17,19,19,19,21,19,23,19,25,19,27,19,29,19,31,19,33,19,35,19,37,19,39,19,43,19,45,19,47,19,49,19,51,19,73,19,75,19,77,19,79,19,81,19,83,19,95,19,97,19,99,19,101,19,103,19,105,19,107,19,121,19,-103,17,-101,17,-99,17,-97,17,-95,17,-93,17,-91,17,-89,17,-73,17,-71,17,-69,17,-15,17,-13,17,-11,17,-9,17,-7,17,-5,17,-3,17,-1,17,1,17,3,17,5,17,7,17,9,17,11,17,13,17,15,17,17,17,19,17,21,17,23,17,25,17,27,17,29,17,31,17,33,17,35,17,37,17,39,17,43,17,45,17,47,17,49,17,51,17,73,17,75,17,77,17,79,17,81,17,83,17,95,17,97,17,99,17,101,17,103,17,105,17,107,17,121,17,-91,15,-89,15,-87,15,-85,15,-17,15,-15,15,-13,15,-11,15,-9,15,-7,15,-5,15,-3,15,-1,15,1,15,3,15,5,15,7,15,9,15,11,15,13,15,15,15,17,15,19,15,21,15,23,15,25,15,27,15,29,15,31,15,33,15,35,15,37,15,39,15,41,15,43,15,45,15,47,15,75,15,77,15,79,15,99,15,101,15,103,15,105,15,107,15,109,15,121,15,123,15,-91,13,-89,13,-87,13,-85,13,-17,13,-15,13,-13,13,-11,13,-9,13,-7,13,-5,13,-3,13,-1,13,1,13,3,13,5,13,7,13,9,13,11,13,13,13,15,13,17,13,19,13,21,13,23,13,25,13,27,13,29,13,31,13,33,13,35,13,37,13,39,13,41,13,43,13,45,13,47,13,75,13,77,13,79,13,99,13,101,13,103,13,105,13,107,13,109,13,121,13,123,13,-85,11,-83,11,-81,11,-79,11,-77,11,-75,11,-73,11,-71,11,-69,11,-67,11,-65,11,-63,11,-61,11,-15,11,-13,11,-11,11,-9,11,-7,11,-5,11,-3,11,-1,11,1,11,3,11,5,11,7,11,9,11,11,11,13,11,15,11,17,11,19,11,21,11,23,11,25,11,27,11,29,11,31,11,33,11,35,11,37,11,39,11,41,11,43,11,45,11,47,11,49,11,51,11,77,11,79,11,99,11,101,11,103,11,105,11,123,11,125,11,-85,9,-83,9,-81,9,-79,9,-77,9,-75,9,-73,9,-71,9,-69,9,-67,9,-65,9,-63,9,-61,9,-15,9,-13,9,-11,9,-9,9,-7,9,-5,9,-3,9,-1,9,1,9,3,9,5,9,7,9,9,9,11,9,13,9,15,9,17,9,19,9,21,9,23,9,25,9,27,9,29,9,31,9,33,9,35,9,37,9,39,9,41,9,43,9,45,9,47,9,49,9,51,9,77,9,79,9,99,9,101,9,103,9,105,9,123,9,125,9,-77,7,-75,7,-73,7,-71,7,-69,7,-67,7,-65,7,-63,7,-61,7,-59,7,-57,7,-55,7,-53,7,-7,7,-5,7,-3,7,-1,7,1,7,3,7,5,7,7,7,9,7,11,7,13,7,15,7,17,7,19,7,21,7,23,7,25,7,27,7,29,7,31,7,33,7,35,7,37,7,39,7,41,7,43,7,45,7,47,7,101,7,117,7,123,7,125,7,-77,5,-75,5,-73,5,-71,5,-69,5,-67,5,-65,5,-63,5,-61,5,-59,5,-57,5,-55,5,-53,5,-7,5,-5,5,-3,5,-1,5,1,5,3,5,5,5,7,5,9,5,11,5,13,5,15,5,17,5,19,5,21,5,23,5,25,5,27,5,29,5,31,5,33,5,35,5,37,5,39,5,41,5,43,5,45,5,47,5,101,5,117,5,123,5,125,5,-79,3,-77,3,-75,3,-73,3,-71,3,-69,3,-67,3,-65,3,-63,3,-61,3,-59,3,-57,3,-55,3,-53,3,-51,3,9,3,11,3,13,3,15,3,17,3,19,3,21,3,23,3,25,3,27,3,29,3,31,3,33,3,35,3,37,3,39,3,41,3,97,3,99,3,101,3,103,3,109,3,111,3,113,3,115,3,117,3,119,3,121,3,123,3,125,3,-79,1,-77,1,-75,1,-73,1,-71,1,-69,1,-67,1,-65,1,-63,1,-61,1,-59,1,-57,1,-55,1,-53,1,-51,1,9,1,11,1,13,1,15,1,17,1,19,1,21,1,23,1,25,1,27,1,29,1,31,1,33,1,35,1,37,1,39,1,41,1,97,1,99,1,101,1,103,1,109,1,111,1,113,1,115,1,117,1,119,1,121,1,123,1,125,1,-79,-1,-77,-1,-75,-1,-73,-1,-71,-1,-69,-1,-67,-1,-65,-1,-63,-1,-61,-1,-59,-1,-57,-1,-55,-1,-53,-1,-51,-1,-49,-1,-47,-1,-45,-1,9,-1,11,-1,13,-1,15,-1,17,-1,19,-1,21,-1,23,-1,25,-1,27,-1,29,-1,31,-1,33,-1,35,-1,37,-1,39,-1,41,-1,101,-1,103,-1,105,-1,111,-1,113,-1,115,-1,117,-1,121,-1,123,-1,133,-1,135,-1,137,-1,139,-1,141,-1,143,-1,145,-1,147,-1,149,-1,-79,-3,-77,-3,-75,-3,-73,-3,-71,-3,-69,-3,-67,-3,-65,-3,-63,-3,-61,-3,-59,-3,-57,-3,-55,-3,-53,-3,-51,-3,-49,-3,-47,-3,-45,-3,9,-3,11,-3,13,-3,15,-3,17,-3,19,-3,21,-3,23,-3,25,-3,27,-3,29,-3,31,-3,33,-3,35,-3,37,-3,39,-3,41,-3,101,-3,103,-3,105,-3,111,-3,113,-3,115,-3,117,-3,121,-3,123,-3,133,-3,135,-3,137,-3,139,-3,141,-3,143,-3,145,-3,147,-3,149,-3,-81,-5,-79,-5,-77,-5,-75,-5,-73,-5,-71,-5,-69,-5,-67,-5,-65,-5,-63,-5,-61,-5,-59,-5,-57,-5,-55,-5,-53,-5,-51,-5,-49,-5,-47,-5,-45,-5,-43,-5,-41,-5,-39,-5,-37,-5,-35,-5,13,-5,15,-5,17,-5,19,-5,21,-5,23,-5,25,-5,27,-5,29,-5,31,-5,33,-5,35,-5,37,-5,39,-5,105,-5,107,-5,109,-5,111,-5,113,-5,115,-5,139,-5,141,-5,143,-5,145,-5,147,-5,149,-5,-81,-7,-79,-7,-77,-7,-75,-7,-73,-7,-71,-7,-69,-7,-67,-7,-65,-7,-63,-7,-61,-7,-59,-7,-57,-7,-55,-7,-53,-7,-51,-7,-49,-7,-47,-7,-45,-7,-43,-7,-41,-7,-39,-7,-37,-7,-35,-7,13,-7,15,-7,17,-7,19,-7,21,-7,23,-7,25,-7,27,-7,29,-7,31,-7,33,-7,35,-7,37,-7,39,-7,105,-7,107,-7,109,-7,111,-7,113,-7,115,-7,139,-7,141,-7,143,-7,145,-7,147,-7,149,-7,-77,-9,-75,-9,-73,-9,-71,-9,-69,-9,-67,-9,-65,-9,-63,-9,-61,-9,-59,-9,-57,-9,-55,-9,-53,-9,-51,-9,-49,-9,-47,-9,-45,-9,-43,-9,-41,-9,-39,-9,-37,-9,13,-9,15,-9,17,-9,19,-9,21,-9,23,-9,25,-9,27,-9,29,-9,31,-9,33,-9,35,-9,37,-9,39,-9,121,-9,123,-9,125,-9,143,-9,-77,-11,-75,-11,-73,-11,-71,-11,-69,-11,-67,-11,-65,-11,-63,-11,-61,-11,-59,-11,-57,-11,-55,-11,-53,-11,-51,-11,-49,-11,-47,-11,-45,-11,-43,-11,-41,-11,-39,-11,-37,-11,13,-11,15,-11,17,-11,19,-11,21,-11,23,-11,25,-11,27,-11,29,-11,31,-11,33,-11,35,-11,37,-11,39,-11,121,-11,123,-11,125,-11,143,-11,-75,-13,-73,-13,-71,-13,-69,-13,-67,-13,-65,-13,-63,-13,-61,-13,-59,-13,-57,-13,-55,-13,-53,-13,-51,-13,-49,-13,-47,-13,-45,-13,-43,-13,-41,-13,-39,-13,13,-13,15,-13,17,-13,19,-13,21,-13,23,-13,25,-13,27,-13,29,-13,31,-13,33,-13,35,-13,37,-13,39,-13,41,-13,49,-13,127,-13,129,-13,131,-13,133,-13,135,-13,141,-13,143,-13,-75,-15,-73,-15,-71,-15,-69,-15,-67,-15,-65,-15,-63,-15,-61,-15,-59,-15,-57,-15,-55,-15,-53,-15,-51,-15,-49,-15,-47,-15,-45,-15,-43,-15,-41,-15,-39,-15,13,-15,15,-15,17,-15,19,-15,21,-15,23,-15,25,-15,27,-15,29,-15,31,-15,33,-15,35,-15,37,-15,39,-15,41,-15,49,-15,127,-15,129,-15,131,-15,133,-15,135,-15,141,-15,143,-15,-71,-17,-69,-17,-67,-17,-65,-17,-63,-17,-61,-17,-59,-17,-57,-17,-55,-17,-53,-17,-51,-17,-49,-17,-47,-17,-45,-17,-43,-17,-41,-17,-39,-17,13,-17,15,-17,17,-17,19,-17,21,-17,23,-17,25,-17,27,-17,29,-17,31,-17,33,-17,35,-17,37,-17,45,-17,47,-17,49,-17,123,-17,125,-17,127,-17,129,-17,131,-17,133,-17,135,-17,137,-17,139,-17,141,-17,143,-17,145,-17,-71,-19,-69,-19,-67,-19,-65,-19,-63,-19,-61,-19,-59,-19,-57,-19,-55,-19,-53,-19,-51,-19,-49,-19,-47,-19,-45,-19,-43,-19,-41,-19,-39,-19,13,-19,15,-19,17,-19,19,-19,21,-19,23,-19,25,-19,27,-19,29,-19,31,-19,33,-19,35,-19,37,-19,45,-19,47,-19,49,-19,123,-19,125,-19,127,-19,129,-19,131,-19,133,-19,135,-19,137,-19,139,-19,141,-19,143,-19,145,-19,-69,-21,-67,-21,-65,-21,-63,-21,-61,-21,-59,-21,-57,-21,-55,-21,-53,-21,-51,-21,-49,-21,-47,-21,-45,-21,-43,-21,-41,-21,15,-21,17,-21,19,-21,21,-21,23,-21,25,-21,27,-21,29,-21,31,-21,33,-21,35,-21,43,-21,45,-21,47,-21,115,-21,117,-21,119,-21,121,-21,123,-21,125,-21,127,-21,129,-21,131,-21,133,-21,135,-21,137,-21,139,-21,141,-21,143,-21,145,-21,147,-21,149,-21,-69,-23,-67,-23,-65,-23,-63,-23,-61,-23,-59,-23,-57,-23,-55,-23,-53,-23,-51,-23,-49,-23,-47,-23,-45,-23,-43,-23,-41,-23,15,-23,17,-23,19,-23,21,-23,23,-23,25,-23,27,-23,29,-23,31,-23,33,-23,35,-23,43,-23,45,-23,47,-23,115,-23,117,-23,119,-23,121,-23,123,-23,125,-23,127,-23,129,-23,131,-23,133,-23,135,-23,137,-23,139,-23,141,-23,143,-23,145,-23,147,-23,149,-23,-69,-25,-67,-25,-65,-25,-63,-25,-61,-25,-59,-25,-57,-25,-55,-25,-53,-25,-51,-25,-49,-25,15,-25,17,-25,19,-25,21,-25,23,-25,25,-25,27,-25,29,-25,31,-25,33,-25,113,-25,115,-25,117,-25,119,-25,121,-25,123,-25,125,-25,127,-25,129,-25,131,-25,133,-25,135,-25,137,-25,139,-25,141,-25,143,-25,145,-25,147,-25,149,-25,151,-25,153,-25,-69,-27,-67,-27,-65,-27,-63,-27,-61,-27,-59,-27,-57,-27,-55,-27,-53,-27,-51,-27,-49,-27,15,-27,17,-27,19,-27,21,-27,23,-27,25,-27,27,-27,29,-27,31,-27,33,-27,113,-27,115,-27,117,-27,119,-27,121,-27,123,-27,125,-27,127,-27,129,-27,131,-27,133,-27,135,-27,137,-27,139,-27,141,-27,143,-27,145,-27,147,-27,149,-27,151,-27,153,-27,-71,-29,-69,-29,-67,-29,-65,-29,-63,-29,-61,-29,-59,-29,-57,-29,-55,-29,-53,-29,-51,-29,17,-29,19,-29,21,-29,23,-29,25,-29,27,-29,29,-29,31,-29,115,-29,117,-29,119,-29,121,-29,123,-29,125,-29,127,-29,129,-29,131,-29,133,-29,135,-29,137,-29,139,-29,141,-29,143,-29,145,-29,147,-29,149,-29,151,-29,153,-29,-71,-31,-69,-31,-67,-31,-65,-31,-63,-31,-61,-31,-59,-31,-57,-31,-55,-31,-53,-31,-51,-31,17,-31,19,-31,21,-31,23,-31,25,-31,27,-31,29,-31,31,-31,115,-31,117,-31,119,-31,121,-31,123,-31,125,-31,127,-31,129,-31,131,-31,133,-31,135,-31,137,-31,139,-31,141,-31,143,-31,145,-31,147,-31,149,-31,151,-31,153,-31,-71,-33,-69,-33,-67,-33,-65,-33,-63,-33,-61,-33,-59,-33,-57,-33,-55,-33,19,-33,21,-33,23,-33,25,-33,115,-33,117,-33,119,-33,121,-33,123,-33,135,-33,137,-33,139,-33,141,-33,143,-33,145,-33,147,-33,149,-33,151,-33,-71,-35,-69,-35,-67,-35,-65,-35,-63,-35,-61,-35,-59,-35,-57,-35,-55,-35,19,-35,21,-35,23,-35,25,-35,115,-35,117,-35,119,-35,121,-35,123,-35,135,-35,137,-35,139,-35,141,-35,143,-35,145,-35,147,-35,149,-35,151,-35,-73,-37,-71,-37,-69,-37,-67,-37,-65,-37,-63,-37,-61,-37,-59,-37,-57,-37,141,-37,143,-37,145,-37,147,-37,149,-37,175,-37,177,-37,-73,-39,-71,-39,-69,-39,-67,-39,-65,-39,-63,-39,-61,-39,-59,-39,-57,-39,141,-39,143,-39,145,-39,147,-39,149,-39,175,-39,177,-39,-73,-41,-71,-41,-69,-41,-67,-41,-65,-41,-63,-41,145,-41,147,-41,171,-41,173,-41,-73,-43,-71,-43,-69,-43,-67,-43,-65,-43,-63,-43,145,-43,147,-43,171,-43,173,-43,-75,-45,-73,-45,-71,-45,-69,-45,-67,-45,167,-45,169,-45,171,-45,-75,-47,-73,-47,-71,-47,-69,-47,-67,-47,167,-47,169,-47,171,-47,-75,-49,-73,-49,-71,-49,-69,-49,-75,-51,-73,-51,-71,-51,-69,-51,-71,-53,-69,-53,-67,-53,-71,-55,-69,-55,-67,-55];

mount(document.getElementById('app'), App);