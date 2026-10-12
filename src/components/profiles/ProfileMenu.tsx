import { PopupShell, closePopup, openPopup, type PopupProps } from "../shell/popups";
import { useStore } from "../../lib/store";
import { PROFILE_LIST, profileLabel, type Profile } from "./gate";
import { profileStore, setProfile, useProfile } from "./profile";
import { setRepoSection } from "../../lib/repoConfig";
import { toast } from "./notice";

/** Profile row at the bottom of the toolbar's project widget menu (RecentProjects popup). */
export function ProfileRow({ onClose }: { onClose: () => void }) {
  const p = useProfile();
  return (
    <div className="rp-profile" data-testid="profile-row">
      <span className="rp-profile-l">Profile</span>
      <div className="seg">
        {PROFILE_LIST.map((x) => (
          <button key={x.id} data-profile={x.id} className={p === x.id ? "on" : ""} title={x.blurb} onClick={() => { onClose(); void setProfile(x.id); }}>{x.label}</button>
        ))}
      </div>
    </div>
  );
}

/** Status bar: the current profile, always visible; click to switch. */
export function ProfileStatusWidget() {
  const p = useProfile();
  return (
    <span className="sb-item" data-testid="profile-status" title="Switch Profile (Developer / Asset Dev)" onClick={openSwitchProfile}>
      {profileLabel(p)} ▾
    </span>
  );
}

/** Find Action > "Switch Profile…" */
export function SwitchProfilePopup({ onClose }: PopupProps) {
  const p = useProfile();
  return (
    <PopupShell onClose={onClose} width={460}>
      <div className="popup-tabs"><span className="popup-title">Switch Profile</span></div>
      <div className="rp-list" data-testid="switch-profile">
        {PROFILE_LIST.map((x) => (
          <div key={x.id} data-profile={x.id} className={"popup-row se-row" + (p === x.id ? " selected" : "")} onClick={() => { onClose(); void setProfile(x.id); }}>
            <span className="rp-check">{p === x.id ? "✓" : ""}</span>
            <span className="se-label">{x.label}</span>
            <span className="se-sec">{x.blurb}</span>
          </div>
        ))}
      </div>
    </PopupShell>
  );
}

/** Settings > Profile */
export function ProfileSettingsPopup({ onClose }: PopupProps) {
  const p = useProfile();
  const { suggested, source } = useStore(profileStore);
  return (
    <PopupShell onClose={onClose} width={620}>
      <div className="popup-tabs"><span className="popup-title">Settings › Profile</span></div>
      <div className="ap-settings" data-testid="profile-settings">
        <div className="ap-field-label">What do you want to see?</div>
        {PROFILE_LIST.map((x) => (
          <label key={x.id} className="ap-radio" data-profile={x.id}>
            <input type="radio" name="profile" checked={p === x.id} onChange={() => void setProfile(x.id)} />
            <span><b>{x.label}</b><br /><span className="dim">{x.blurb}</span></span>
          </label>
        ))}
        <div className="ap-field-label">This project</div>
        <div className="dim">
          {suggested ? `This project suggests ${profileLabel(suggested)}.` : "This project doesn't suggest a profile."}
          {source === "user" && suggested && suggested !== p ? " You chose differently." : ""}
        </div>
        <div className="ap-buttons" style={{ justifyContent: "flex-start" }}>
          <button data-testid="profile-suggest" onClick={async () => { try { await setRepoSection("profile", p); toast(`New teammates will be offered ${profileLabel(p)} when they open this project.`, "ok", 5000); } catch (e) { toast(String(e), "warn"); } }}>Suggest {profileLabel(p)} to my team</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </PopupShell>
  );
}

export const openSwitchProfile = () => openPopup("SwitchProfile");
export const openProfileSettings = () => { closePopup(); setTimeout(() => openPopup("ProfileSettings"), 0); };
export const switchTo = (p: Profile) => setProfile(p);
