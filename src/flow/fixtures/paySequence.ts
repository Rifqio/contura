// Plan E: the mockup's Pay sequence in the language, used by the sequence drawing's tests, Publish and the live check.
// Ten messages numbered 1 to 10, one self-message (3), two activations, one opt in warning around message 6.
export const PAY = `diagram sequence "Pay"
autonumber
participant Customer [icon: user, color: muted]
participant Web app [icon: monitor, color: info]
participant Billing API [icon: server, color: accent]
participant Card provider [icon: credit-card, color: warning]
participant Database [icon: database, color: success]

Customer -> Web app: Pay
Web app -> Billing API: charge(total)
activate Billing API
Billing API -> Billing API: check fraud score
activate Card provider
Billing API -> Card provider: authorize
Card provider --> Billing API: approved
deactivate Card provider
opt card saved [color: warning] {
  Billing API -> Database: save card token
}
Billing API -> Database: save payment
Database --> Billing API: ok
Billing API --> Web app: paid
deactivate Billing API
Web app --> Customer: show receipt
`;
