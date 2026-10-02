import { useCallback, useEffect, useRef, useState } from "react";

const TOTAL_FRAMES = 120;
const MOBILE_BREAKPOINT = 768;
const SCROLL_HEIGHT_VH = 420;

const menuItems = [
  { id: "mori-stack", name: "The Mori Stack", description: "double smash patty, sharp cheddar, smoked bacon, house sauce", price: 18 },
  { id: "garden-stack", name: "Garden Stack", description: "crispy mushroom, lettuce, tomato, pickled onion, herb mayo", price: 15 },
  { id: "sunrise-bun", name: "Sunrise Bun", description: "soft egg, tomato jam, aged cheddar, hash brown", price: 13 },
  { id: "crisp-potatoes", name: "Crisp Potatoes", description: "sea salt, parsley, lemon aioli", price: 7 },
];

const frameSource = (frameNumber) =>
  `/frames/ezgif-frame-${String(frameNumber).padStart(3, "0")}.png`;

const preloadImage = (source) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${source}`));
    image.src = source;
  });

const readApiResponse = async (response) => {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("The booking service is unavailable. Open the site at http://localhost:4173.");
  }
  if (!response.ok) throw new Error(data.message || "The request could not be saved.");
  return data;
};

export default function MoriCafe() {
  const sectionRef = useRef(null);
  const canvasRef = useRef(null);
  const framesRef = useRef([]);
  const requestedFrameRef = useRef(0);
  const drawnFrameRef = useRef(-1);
  const rafRef = useRef(0);
  const resizeRequestedRef = useRef(false);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [cart, setCart] = useState([]);
  const [bookingStatus, setBookingStatus] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [submittingBooking, setSubmittingBooking] = useState(false);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [entryCount, setEntryCount] = useState(null);
  const [privacyStatus, setPrivacyStatus] = useState("");

  const refreshEntryCount = useCallback(async () => {
    try {
      const response = await fetch("/api/entry-count");
      const counts = await readApiResponse(response);
      setEntryCount(counts.bookingCount + counts.orderCount);
    } catch {
      setEntryCount(null);
    }
  }, []);

  useEffect(() => { refreshEntryCount(); }, [refreshEntryCount]);

  const addToOrder = (item) => {
    setCart((currentCart) => {
      const existing = currentCart.find((entry) => entry.id === item.id);
      return existing
        ? currentCart.map((entry) => entry.id === item.id ? { ...entry, quantity: entry.quantity + 1 } : entry)
        : [...currentCart, { ...item, quantity: 1 }];
    });
    setOrderStatus("");
  };

  const updateQuantity = (id, quantity) => {
    setCart((currentCart) => currentCart
      .map((entry) => entry.id === id ? { ...entry, quantity } : entry)
      .filter((entry) => entry.quantity > 0));
  };

  const cartTotal = cart.reduce((total, item) => total + item.price * item.quantity, 0);

  const submitBooking = async (event) => {
    event.preventDefault();
    setSubmittingBooking(true);
    setBookingStatus("");
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    try {
      const response = await fetch("/api/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await readApiResponse(response);
      form.reset();
      setBookingStatus(`${data.workbookUpdated ? "Booking saved to mori-requests.xlsx." : "Booking saved. Close mori-requests.xlsx and it will update automatically."} Save request ID ${data.bookingId} and privacy code ${data.privacyCode} to delete it later.`);
      refreshEntryCount();
    } catch (error) {
      setBookingStatus(error.message || "Could not save the booking.");
    } finally {
      setSubmittingBooking(false);
    }
  };

  const submitOrder = async (event) => {
    event.preventDefault();
    setSubmittingOrder(true);
    setOrderStatus("");
    const form = event.currentTarget;
    const payload = { ...Object.fromEntries(new FormData(form)), items: cart.map(({ id, quantity }) => ({ id, quantity })) };
    try {
      const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await readApiResponse(response);
      form.reset();
      setCart([]);
      setOrderStatus(`${data.workbookUpdated ? `Order saved to mori-requests.xlsx. Total: $${data.total}.` : `Order saved. Close mori-requests.xlsx and it will update automatically. Total: $${data.total}.`} Save request ID ${data.orderId} and privacy code ${data.privacyCode} to delete it later.`);
      refreshEntryCount();
    } catch (error) {
      setOrderStatus(error.message || "Could not save the order.");
    } finally {
      setSubmittingOrder(false);
    }
  };

  const deleteSavedRequest = async (event) => {
    event.preventDefault();
    setPrivacyStatus("");
    const form = event.currentTarget;
    try {
      const response = await fetch("/api/privacy/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      const data = await readApiResponse(response);
      form.reset();
      setPrivacyStatus(data.message);
      refreshEntryCount();
    } catch (error) {
      setPrivacyStatus(error.message || "Could not delete the saved request.");
    }
  };

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.round(window.innerWidth * pixelRatio);
    const nextHeight = Math.round(window.innerHeight * pixelRatio);

    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
  }, []);

  const drawFrame = useCallback((frame) => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;

    const context = canvas.getContext("2d");
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const imageRatio = frame.naturalWidth / frame.naturalHeight;
    const canvasRatio = canvasWidth / canvasHeight;

    // Cover the viewport while preserving the source image aspect ratio.
    let drawWidth = canvasWidth;
    let drawHeight = canvasHeight;
    let x = 0;
    let y = 0;

    if (imageRatio > canvasRatio) {
      drawWidth = canvasHeight * imageRatio;
      x = (canvasWidth - drawWidth) / 2;
    } else {
      drawHeight = canvasWidth / imageRatio;
      y = (canvasHeight - drawHeight) / 2;
    }

    context.clearRect(0, 0, canvasWidth, canvasHeight);
    context.drawImage(frame, x, y, drawWidth, drawHeight);
  }, []);

  const requestPaint = useCallback(() => {
    if (rafRef.current) return;

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      const nextIndex = requestedFrameRef.current;
      const frameChanged = drawnFrameRef.current !== nextIndex;

      // Scroll handlers only update requestedFrameRef. Canvas work happens here.
      if (frameChanged || resizeRequestedRef.current) {
        drawFrame(framesRef.current[nextIndex]);
        drawnFrameRef.current = nextIndex;
        resizeRequestedRef.current = false;
      }
    });
  }, [drawFrame]);

  useEffect(() => {
    const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreferences = () => {
      setIsMobile(mobileQuery.matches);
      setReducedMotion(motionQuery.matches);
    };

    syncPreferences();
    mobileQuery.addEventListener("change", syncPreferences);
    motionQuery.addEventListener("change", syncPreferences);
    return () => {
      mobileQuery.removeEventListener("change", syncPreferences);
      motionQuery.removeEventListener("change", syncPreferences);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const frameStep = isMobile ? 2 : 1;
    const frameNumbers = reducedMotion
      ? [1]
      : Array.from({ length: Math.ceil(TOTAL_FRAMES / frameStep) }, (_, index) => index * frameStep + 1);

    setLoading(true);
    setLoadError(false);
    setLoadingProgress(0);
    framesRef.current = [];
    drawnFrameRef.current = -1;

    const loadFrames = async () => {
      try {
        let completedFrames = 0;
        const frames = await Promise.all(
          frameNumbers.map(async (frameNumber) => {
            const frame = await preloadImage(frameSource(frameNumber));
            if (!cancelled) {
              completedFrames += 1;
              setLoadingProgress(Math.round((completedFrames / frameNumbers.length) * 100));
            }
            return frame;
          }),
        );

        if (cancelled) return;
        framesRef.current = frames;
        requestedFrameRef.current = 0;
        resizeCanvas();
        resizeRequestedRef.current = true;
        setLoading(false);
        requestPaint();
      } catch (error) {
        if (!cancelled) {
          setLoadError(true);
          setLoading(false);
        }
      }
    };

    loadFrames();
    return () => {
      cancelled = true;
    };
  }, [isMobile, reducedMotion, requestPaint, resizeCanvas]);

  useEffect(() => {
    if (loading || loadError || reducedMotion) return undefined;

    const updateFrameFromScroll = () => {
      const section = sectionRef.current;
      const frames = framesRef.current;
      if (!section || !frames.length) return;

      const sectionTop = section.getBoundingClientRect().top;
      const scrollDistance = Math.max(section.offsetHeight - window.innerHeight, 1);
      const travelled = Math.min(Math.max(-sectionTop, 0), scrollDistance);

      // Normalize the scroll distance (0 to 1), then map it across the loaded frame indexes.
      // Change SCROLL_HEIGHT_VH to spread the same frames over more or less scroll distance.
      const progress = travelled / scrollDistance;
      requestedFrameRef.current = Math.round(progress * (frames.length - 1));
      requestPaint();
    };

    const handleResize = () => {
      resizeCanvas();
      resizeRequestedRef.current = true;
      updateFrameFromScroll();
    };

    updateFrameFromScroll();
    window.addEventListener("scroll", updateFrameFromScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", updateFrameFromScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [loading, loadError, reducedMotion, requestPaint, resizeCanvas]);

  useEffect(() => () => window.cancelAnimationFrame(rafRef.current), []);

  return (
    <main>
      <section
        ref={sectionRef}
        className={`sequence-section ${reducedMotion ? "sequence-section-static" : ""}`}
        style={{ "--sequence-height": `${SCROLL_HEIGHT_VH}vh` }}
        aria-label="Mori Cafe burger assembly"
      >
        <div className="sequence-sticky">
          <canvas ref={canvasRef} className="sequence-canvas" aria-hidden="true" />
          <div className="hero-scrim" />

          <header className="site-header">
            <a className="wordmark" href="#top" aria-label="Mori Cafe home">
              MORI<span>CAFE + KITCHEN</span>
            </a>
            <nav aria-label="Main navigation">
              <a href="#menu">Menu</a>
              <a href="#order">Order</a>
              <a href="#visit">Visit</a>
              <a href="#book">Book</a>
            </nav>
          </header>

          <div id="top" className="hero-copy">
            <p className="eyebrow">All day cafe. Midnight kitchen.</p>
            <h1>Built around<br />the good stuff.</h1>
            <p className="hero-detail">Scroll to take apart our signature stack, layer by layer.</p>
            <a className="button button-dark" href="#book">Book a table</a>
          </div>

          <div className="hero-bottom">
            <span>Open today 8:00 - late</span>
            <span className="scroll-cue">{reducedMotion ? "Signature stack" : "Scroll to build it"}</span>
          </div>

          {loading && (
            <div className="loading-layer" role="status" aria-live="polite">
              <div className="loading-mark">M</div>
              <p>Preparing the kitchen</p>
              <div className="loading-track"><span style={{ width: `${loadingProgress}%` }} /></div>
              <small>{loadingProgress}%</small>
            </div>
          )}

          {loadError && (
            <div className="loading-layer error-layer" role="alert">
              <div className="loading-mark">!</div>
              <p>The sequence could not load.</p>
              <button className="button button-dark" onClick={() => window.location.reload()}>Try again</button>
            </div>
          )}
        </div>
      </section>

      <section id="menu" className="menu-section">
        <div className="section-intro">
          <p className="eyebrow">The counter menu</p>
          <h2>Nothing hidden.<br />Everything considered.</h2>
        </div>
        <div className="menu-list" aria-label="Featured menu">
          {menuItems.map((item) => (
            <article className="menu-item" key={item.id}>
              <div><h3>{item.name}</h3><p>{item.description}</p></div>
              <div className="menu-action"><strong>${item.price}</strong><button type="button" onClick={() => addToOrder(item)}>Add</button></div>
            </article>
          ))}
        </div>
      </section>

      <section id="order" className="order-section">
        <div className="section-intro"><p className="eyebrow">Order ahead</p><h2>Your table,<br />your takeaway.</h2><p className="order-intro">Add menu items above, then send the order straight to the kitchen sheet.</p></div>
        <form className="order-form" onSubmit={submitOrder}>
          <div className="cart-list" aria-live="polite">
            {cart.length ? cart.map((item) => <div className="cart-item" key={item.id}><span>{item.name}</span><div><button type="button" aria-label={`Remove one ${item.name}`} onClick={() => updateQuantity(item.id, item.quantity - 1)}>-</button><b>{item.quantity}</b><button type="button" aria-label={`Add one ${item.name}`} onClick={() => updateQuantity(item.id, item.quantity + 1)}>+</button></div><strong>${item.price * item.quantity}</strong></div>) : <p className="empty-cart">Your order is empty.</p>}
          </div>
          <div className="order-total"><span>Total</span><strong>${cartTotal}</strong></div>
          <div className="order-fields"><label>Name<input required name="customer" placeholder="Your name" /></label><label>Phone<input required name="phone" type="tel" placeholder="Phone number" /></label><label>Fulfillment<select name="fulfillment" defaultValue="Pickup"><option>Pickup</option><option>Delivery</option></select></label><label>Notes<input name="notes" placeholder="Allergies or special requests" /></label></div>
          <button className="button button-dark" disabled={submittingOrder} type="submit">{submittingOrder ? "Saving order" : "Send order"}</button>
          {orderStatus && <p className="form-status" role="status">{orderStatus}</p>}
        </form>
      </section>

      <section id="visit" className="visit-section">
        <div className="visit-title"><p className="eyebrow">Find your seat</p><h2>Stay awhile.</h2></div>
        <div className="visit-grid">
          <div><p className="label">Hours</p><p>Mon - Thu: 8:00 - 23:00<br />Fri - Sat: 8:00 - 00:00<br />Sun: 9:00 - 22:00</p></div>
          <div><p className="label">Address</p><p>17 Market Lane<br />Your Neighborhood, 10001</p><a href="https://maps.google.com/?q=17+Market+Lane" target="_blank" rel="noreferrer">Get directions</a></div>
          <div><p className="label">Contact</p><a href="tel:+12125550178">+1 212 555 0178</a><br /><a href="mailto:hello@moricafe.example">hello@moricafe.example</a><p className="small-note">Walk-ins always welcome.</p></div>
        </div>
      </section>

      <section id="book" className="booking-section">
        <div><p className="eyebrow">Reservations</p><h2>A table, with<br />your name on it.</h2><p className="booking-note">For groups of 7 or more, tell us a little about the occasion.</p></div>
        <form className="booking-form" onSubmit={submitBooking}>
          <label>Name<input required name="name" placeholder="Your name" /></label>
          <label>Email<input required type="email" name="email" placeholder="you@example.com" /></label>
          <label>Guests<select defaultValue="2" name="guests"><option value="1">1 guest</option><option value="2">2 guests</option><option value="3">3 guests</option><option value="4">4 guests</option><option value="5">5 guests</option><option value="6">6 guests</option></select></label>
          <label>Date<input required name="date" type="date" /></label>
          <label>Time<input required name="time" type="time" /></label>
          <button className="button button-lime" disabled={submittingBooking} type="submit">{submittingBooking ? "Saving request" : "Request a table"}</button>
          {bookingStatus && <p className="form-status" role="status">{bookingStatus}</p>}
        </form>
      </section>

      <section id="privacy" className="privacy-section">
        <div><p className="eyebrow">Privacy</p><h2>Delete a saved request.</h2><p>Use the request ID and privacy code shown after you submit a booking or order.</p></div>
        <form className="privacy-form" onSubmit={deleteSavedRequest}>
          <label>Request ID<input required name="requestId" placeholder="BK- or OR-" /></label>
          <label>Privacy code<input required name="privacyCode" placeholder="24-character code" /></label>
          <button className="button button-dark" type="submit">Delete request</button>
          {privacyStatus && <p className="form-status" role="status">{privacyStatus}</p>}
        </form>
      </section>

      <footer>
        <p>MORI CAFE + KITCHEN</p>
        <p>Good food, no ceremony.</p>
        <p className="footer-note">{entryCount === null ? "Saved entries unavailable" : `${entryCount} saved entries`}</p>
      </footer>
    </main>
  );
}
